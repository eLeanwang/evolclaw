/**
 * Response Mode Resolver
 *
 * 模式解析：决定某个会话该用哪个响应模式。
 *
 * responseMode 是**标量**参数，走特殊路线（不同于 chatmode/mentionMode/model 的普通配置链）：
 * 候选清单与默认值来自**注册表**，不来自 schema。解析优先级（高→低）：
 *   1. 关系级 responseMode（$RELATIONS_DIR/<peerKey>/config.json）
 *   2. agent 级 responseMode（$AGENT_DIR/config.json）
 *   3. 注册表首选响应模式（registry.getPreferred()，当前为 single-session）
 *
 * 关系级 > agent 级由 ConfigManager 按 `x-merge: scalar` 合并完成，因此本解析器
 * 收到的是**合并后的标量值**；只需「有值用值、无值用注册表首选」。
 *
 * 注：旧的 response_modes 块（default_private/default_group/configs/overrides）已废除。
 *    chatMode 从顶层 chatmode 字典读、与选模式正交；模式特有参数从顶层 config 块读。
 */

import type { ResponseMode } from './types.js';
import type { ResponseModeRegistry } from './registry.js';

export interface ResolvedMode {
  mode: ResponseMode;
  /** 解析来源（用于 ec response current 显示与调试） */
  source: 'config' | 'preferred';
}

export class ResponseModeResolver {
  constructor(private registry: ResponseModeRegistry) {}

  /**
   * 解析会话的响应模式。
   *
   * @param responseModeId 合并后的标量 responseMode（关系级>agent级，可空）
   */
  resolve(responseModeId: string | undefined): ResolvedMode {
    if (responseModeId) {
      const mode = this.registry.get(responseModeId);
      if (mode) return { mode, source: 'config' };
      // 配了不存在的模式：不抛错（避免单个坏配置卡死会话），回落注册表首选
    }
    return { mode: this.registry.getPreferred(), source: 'preferred' };
  }
}
