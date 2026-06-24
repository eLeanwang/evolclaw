/**
 * Response Mode Coordinator
 *
 * 响应模式系统接入消息流的中枢。把 Registry/Resolver/ContextBuilder 串起来，
 * 为 message-processor 提供两个能力：
 *   - resolveInbound：解析会话该用哪个模式 + 运行 handleInbound 得到决策（含 runtimeState）
 *   - resolveOutbound：对某个出站 payload 运行 handleOutbound 得到发送决策
 *
 * 设计原则（无缝迁移）：
 *   - 解析优先级：response_modes 配置 > session.chatMode（兼容现状）> 系统兜底
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
   * @param chatType 会话类型
   * @param peerKey 对端标识（override 查找）
   * @param rmConfig response_modes 配置
   * @param chatModeFallback 现有 session.chatMode（config 未设时回落）
   * @param contextDeps 构建 context 所需依赖
   */
  resolveMode(
    chatType: 'private' | 'group',
    peerKey: string | undefined,
    rmConfig: any,
    chatModeFallback: string | undefined,
    contextDeps: Omit<ContextDeps, 'modeConfig'>,
  ): { mode: ResponseMode; context: ResponseModeContext } | null {
    try {
      let resolved = this.resolver.resolve(chatType, peerKey, rmConfig);
      if (resolved.source === 'fallback' && chatModeFallback && this.registry.has(chatModeFallback)) {
        const mode = this.registry.get(chatModeFallback)!;
        resolved = { mode, config: rmConfig?.configs?.[chatModeFallback] ?? {}, source: 'default' };
      }
      const mode = resolved.mode;
      const context = this.contextBuilder.build(mode.id, { ...contextDeps, modeConfig: resolved.config });
      return { mode, context };
    } catch (e) {
      contextDeps.logger.warn(`[Coordinator] resolveMode failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * 解析会话的入站响应模式 + 运行 handleInbound。
   *
   * @param message 入站消息（含 chatType，用于解析）
   * @param chatModeFallback 现有 session.chatMode（兼容回落：config 未设时用它）
   */
  async resolveInbound(
    message: InboundMessage,
    deps: CoordinatorInboundDeps,
    chatModeFallback: string | undefined,
  ): Promise<ResolvedInbound | null> {
    try {
      const chatType = message.chatType ?? 'private';
      const rmConfig = deps.agentConfig.response_modes;

      // 解析模式：config 优先；config 未命中时用 session.chatMode 回落（兼容现状）
      let resolved = this.resolver.resolve(chatType, deps.peerKey, rmConfig);
      if (resolved.source === 'fallback' && chatModeFallback && this.registry.has(chatModeFallback)) {
        // config 没指定 → 用现有 session.chatMode（interactive/proactive）
        const mode = this.registry.get(chatModeFallback)!;
        resolved = { mode, config: rmConfig?.configs?.[chatModeFallback] ?? {}, source: 'default' };
      }

      const mode = resolved.mode;
      const context = this.contextBuilder.build(mode.id, {
        ...deps.contextDeps,
        modeConfig: resolved.config,
      });

      await mode.initialize(context);
      const decision = await mode.handleInbound(message);

      return { modeId: mode.id, decision, mode, context };
    } catch (e) {
      deps.contextDeps.logger.warn(
        `[Coordinator] resolveInbound failed, falling back to chatMode='${chatModeFallback}': ${e instanceof Error ? e.message : String(e)}`,
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
