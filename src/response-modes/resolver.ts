/**
 * Response Mode Resolver
 *
 * 模式解析：决定某个会话该用哪个响应模式。
 *
 * 解析优先级（高→低）：
 *   1. relation override（overrides[peerKey].mode）—— 特定对端/群的指定模式
 *   2. chatType 默认（default_private / default_group）
 *   3. 系统兜底（private→interactive, group→proactive）
 *
 * 注：response_modes 配置块在 Phase 4 接入 AgentConfig；
 *    此处定义独立的输入形状，Phase 4 直接对接，无需改 resolver。
 */

import type { ResponseMode } from './types.js';
import type { ResponseModeRegistry } from './registry.js';
import type { ResponseModesConfig } from '../types.js';

// ResponseModesConfig 的权威定义在 src/types.ts（与 AgentConfig 同源）。
// 此处 re-export，方便响应模式系统内部引用。
export type { ResponseModesConfig };

/** 系统兜底模式 id（response_modes 完全缺失时使用） */
const FALLBACK_PRIVATE = 'interactive';
const FALLBACK_GROUP = 'proactive';

export interface ResolvedMode {
  mode: ResponseMode;
  /** 该模式的配置（合并 configs[id] 与 override.config） */
  config: any;
  /** 解析来源（用于 ec response current 显示与调试） */
  source: 'override' | 'default' | 'fallback';
}

export class ResponseModeResolver {
  constructor(private registry: ResponseModeRegistry) {}

  /**
   * 解析会话的响应模式。
   *
   * @param chatType 会话类型
   * @param peerKey  对端标识（<channel>#<peerId>），用于 override 查找
   * @param config   响应模式配置块（可空，缺失时走兜底）
   */
  resolve(
    chatType: 'private' | 'group',
    peerKey: string | undefined,
    config: ResponseModesConfig | undefined,
  ): ResolvedMode {
    // 1. relation override
    if (peerKey && config?.overrides?.[peerKey]) {
      const ov = config.overrides[peerKey];
      const mode = this.registry.get(ov.mode);
      if (mode) {
        const baseConfig = config.configs?.[ov.mode] ?? {};
        return { mode, config: { ...baseConfig, ...(ov.config ?? {}) }, source: 'override' };
      }
      // override 指定了不存在的模式：记录后回落到默认（不抛错，避免单个坏配置卡死会话）
    }

    // 2. chatType 默认
    const defaultId = chatType === 'group' ? config?.default_group : config?.default_private;
    if (defaultId) {
      const mode = this.registry.get(defaultId);
      if (mode) {
        return { mode, config: config?.configs?.[defaultId] ?? {}, source: 'default' };
      }
    }

    // 3. 系统兜底
    const fallbackId = chatType === 'group' ? FALLBACK_GROUP : FALLBACK_PRIVATE;
    const mode = this.registry.get(fallbackId);
    if (!mode) {
      throw new Error(`[Resolver] fallback mode '${fallbackId}' not registered — builtin modes must be registered at startup`);
    }
    return { mode, config: config?.configs?.[fallbackId] ?? {}, source: 'fallback' };
  }
}
