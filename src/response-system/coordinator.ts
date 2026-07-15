/**
 * Response Mode Coordinator
 *
 * 响应模式系统接入消息流的中枢。把 Registry/Resolver/ContextBuilder 串起来，
 * 为 message-processor 提供两个能力：
 *   - resolveInbound：解析会话该用哪个模式 + 运行 handleInbound 得到决策（含 runtimeState）
 *   - resolveOutbound：对某个出站 payload 运行 handleOutbound 得到发送决策
 *
 * 设计原则：
 *   - 选模式：标量 responseMode（关系级>agent级，合并后）> 注册表首选（single-session）
 *   - chatMode 与选模式正交：由顶层 chatmode 字典按对端类型解析后注入 modeConfig
 *   - 模式特有参数：从 responseModeParams[modeId] 桶读取
 *   - 响应模式成为「响应决策的源头」，下游 message-processor 的执行流程原样保留
 *   - 异常不降级（D6）：解析/决策失败时回落到安全默认，记 WARN
 */

import type { Session, EffectiveAgentConfig } from '../types.js';
import type {
  ResponseMode,
  InboundDecision,
  OutboundDecision,
  ResponseModeContext,
  InboundMessage,
  OutboundPayload,
} from './types.js';
import type { ResponseModeRegistry } from './registry.js';
import { ResponseModeResolver } from './resolver.js';
import { ResponseModeContextBuilder, type ContextDeps } from './context-builder.js';

export interface ResolvedInbound {
  /** 解析出的模式 id（interactive/proactive/...） */
  modeId: string;
  /** handleInbound 决策（含 runtimeState） */
  decision: InboundDecision;
  /** 模式实例（供后续 resolveOutbound 复用） */
  mode: ResponseMode;
  /** 构造的 context（供后续 resolveOutbound 复用） */
  context: ResponseModeContext;
}

/** Coordinator 解析所需的运行时依赖（由 message-processor 在接入点提供） */
export interface CoordinatorInboundDeps {
  session: Session;
  agentConfig: EffectiveAgentConfig;
  /** 对端标识（<channel>#<peerId>），用于 override 查找 */
  peerKey: string | undefined;
  /** ContextBuilder 需要的其余依赖（runner/channel/logger/agentDir） */
  contextDeps: Omit<ContextDeps, 'modeConfig'>;
}

export class ResponseModeCoordinator {
  private resolver: ResponseModeResolver;
  private contextBuilder = new ResponseModeContextBuilder();

  constructor(private registry: ResponseModeRegistry) {
    this.resolver = new ResponseModeResolver(registry);
  }

  /**
   * 解析会话该用哪个响应模式 + 构建 context（不调 handleInbound）。
   * 用于消息处理阶段（_processMessageInternal）：此时消息已出队，
   * 需要的是处理钩子（beforeProcess/configureRun/onToolUse 等），而非入队决策。
   *
   * @param responseModeId 合并后的标量 responseMode（关系级>agent级，可空 → 注册表首选）
   * @param resolvedChatMode 本会话生效的 chatMode（宿主按配置层级解析后传入），
   *        注入进模式 config.chatMode；模式据此分流投递方式。与「选哪个模式」无关。
   * @param responseModeParams 按模式分桶的参数字典 { [modeId]: {...} }，取当前模式的桶注入
   * @param contextDeps 构建 context 所需依赖
   */
  resolveMode(
    responseModeId: string | undefined,
    resolvedChatMode: string | undefined,
    responseModeParams: Record<string, any> | undefined,
    contextDeps: Omit<ContextDeps, 'modeConfig'>,
  ): { mode: ResponseMode; context: ResponseModeContext; source: string } | null {
    try {
      const resolved = this.resolver.resolve(responseModeId);
      const mode = resolved.mode;
      // chatMode 注入宿主解析出的值；模式特有参数从 responseModeParams[modeId] 桶读取
      const modeSpecificParams = responseModeParams?.[mode.id] ?? {};
      const modeConfig = { chatMode: resolvedChatMode, ...modeSpecificParams };
      contextDeps.logger.debug('[ResponseSystem] resolveMode mode=' + mode.id + ' source=' + resolved.source + ' chatMode=' + (modeConfig.chatMode ?? 'none'));
      const context = this.contextBuilder.build(mode.id, { ...contextDeps, modeConfig });
      return { mode, context, source: resolved.source };
    } catch (e) {
      contextDeps.logger.warn(`[Coordinator] resolveMode failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * 解析会话的入站响应模式 + 运行 handleInbound。
   *
   * @param message 入站消息
   * @param resolvedChatMode 本会话生效的 chatMode（宿主解析后传入）
   */
  async resolveInbound(
    message: InboundMessage,
    deps: CoordinatorInboundDeps,
    resolvedChatMode: string | undefined,
  ): Promise<ResolvedInbound | null> {
    try {
      // 解析模式：标量 responseMode（合并后）> 注册表首选。chatMode 不参与选模式。
      const resolved = this.resolver.resolve(deps.agentConfig.responseMode);
      const mode = resolved.mode;
      const modeSpecificParams = deps.agentConfig.responseModeParams?.[mode.id] ?? {};
      const modeConfig = { chatMode: resolvedChatMode, ...modeSpecificParams };
      deps.contextDeps.logger.debug('[ResponseSystem] resolveInbound mode=' + mode.id + ' source=' + resolved.source + ' chatMode=' + (modeConfig.chatMode ?? 'none'));
      const context = this.contextBuilder.build(mode.id, {
        ...deps.contextDeps,
        modeConfig,
      });

      await mode.initialize(context);
      const decision = await mode.handleInbound(message);

      return { modeId: mode.id, decision, mode, context };
    } catch (e) {
      deps.contextDeps.logger.warn(
        `[Coordinator] resolveInbound failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * 对某个出站 payload 运行 handleOutbound。
   * 失败时返回 direct（安全默认：照常发送，不静默吞消息）。
   */
  async resolveOutbound(
    resolved: ResolvedInbound,
    payload: OutboundPayload,
  ): Promise<OutboundDecision> {
    try {
      return await resolved.mode.handleOutbound(payload);
    } catch (e) {
      resolved.context.logger.warn(
        `[Coordinator] resolveOutbound failed for kind='${(payload as any).kind}', defaulting to direct: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { method: 'direct', type: 'message' };
    }
  }

  /** 暴露 registry（供 CLI/Menu 查询） */
  getRegistry(): ResponseModeRegistry {
    return this.registry;
  }
}
