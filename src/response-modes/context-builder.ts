/**
 * Response Mode Context Builder
 *
 * 构造 ResponseModeContext —— 响应模式的依赖注入容器。
 *
 * 设计：
 *   - 核心依赖（session/config/channel/logger/sessionState/dataDir）进入 initialize 时即就绪
 *   - 扩展能力（createAuxiliarySession 等）是懒创建工厂，简单模式从不触碰
 *   - 缓存 per-(sessionId, modeId) 的 sessionState，使同会话同模式跨消息保持状态
 *
 * Phase 3 范围：核心字段就绪。辅助会话/线索/工作流工厂在对应内置模式
 * （Phase 6）真正需要时接入 Runner，当前提供明确的"未实现"占位，避免空壳代码。
 */

import path from 'path';
import fs from 'fs';
import type { Session, EffectiveAgentConfig } from '../types.js';
import type { ResponseModeContext, AuxiliarySession } from './types.js';

/** 构造 Context 所需的运行时依赖（由 Coordinator 提供） */
export interface ContextDeps {
  session: Session;
  agentConfig: EffectiveAgentConfig;
  /** 本模式配置（resolver 解析得到） */
  modeConfig: any;
  /** Runner 句柄（辅助会话工厂用，Phase 6 接入） */
  runner: ResponseModeContext['runner'];
  /** Channel 适配（能力查询 + 发送） */
  channel: ResponseModeContext['channel'];
  logger: ResponseModeContext['logger'];
  /** agent 数据根目录（dataDir 由此派生） */
  agentDir: string;
}

export class ResponseModeContextBuilder {
  /** (sessionId::modeId) → sessionState，跨消息保持 */
  private stateCache = new Map<string, Map<string, any>>();

  /**
   * 构造响应模式上下文。
   * @param modeId 模式 id（用于派生 dataDir 与 sessionState 缓存键）
   */
  build(modeId: string, deps: ContextDeps): ResponseModeContext {
    const sessionState = this.getOrCreateState(deps.session.id, modeId);
    const dataDir = this.ensureDataDir(deps.agentDir, modeId);

    return {
      session: deps.session,
      agentConfig: deps.agentConfig,
      modeConfig: deps.modeConfig,
      runner: deps.runner,
      channel: deps.channel,
      logger: deps.logger,
      sessionState,
      dataDir,
      // ─── 扩展能力工厂（懒创建） ───
      createAuxiliarySession: async (_options) => {
        throw new Error('[ContextBuilder] createAuxiliarySession not yet implemented (Phase 6: dual-session)');
      },
      // createThreadManager / createWorkflowEngine 为可选方法，
      // 未实现的模式不会调用；需要时在 Phase 6 接入。
    };
  }

  /** 清理会话状态（会话结束或切换模式时调用） */
  clearState(sessionId: string, modeId?: string): void {
    if (modeId) {
      this.stateCache.delete(`${sessionId}::${modeId}`);
    } else {
      // 清理该会话的所有模式状态
      for (const key of [...this.stateCache.keys()]) {
        if (key.startsWith(`${sessionId}::`)) this.stateCache.delete(key);
      }
    }
  }

  // ─── 内部辅助 ───

  private getOrCreateState(sessionId: string, modeId: string): Map<string, any> {
    const key = `${sessionId}::${modeId}`;
    let state = this.stateCache.get(key);
    if (!state) {
      state = new Map();
      this.stateCache.set(key, state);
    }
    return state;
  }

  private ensureDataDir(agentDir: string, modeId: string): string {
    const dir = path.join(agentDir, 'response-modes', modeId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
