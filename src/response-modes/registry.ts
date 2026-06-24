/**
 * Response Mode Registry
 *
 * 响应模式注册表：管理所有已注册的响应模式（内置 + 扩展）。
 *
 * 设计：
 *   - 内置模式（builtin）：随包发布，在启动时注册
 *   - 扩展模式（extension）：用户自定义，运行时注册
 *   - 扩展不可覆盖内置（id 冲突时拒绝）
 */

import type { ResponseMode } from './types.js';

export class ResponseModeRegistry {
  private modes = new Map<string, ResponseMode>();

  /**
   * 注册内置模式（type 必须为 'builtin'）
   */
  registerBuiltin(mode: ResponseMode): void {
    if (mode.type !== 'builtin') {
      throw new Error(`[Registry] registerBuiltin requires type='builtin', got '${mode.type}' for mode '${mode.id}'`);
    }
    if (this.modes.has(mode.id)) {
      throw new Error(`[Registry] mode id '${mode.id}' already registered`);
    }
    this.modes.set(mode.id, mode);
  }

  /**
   * 注册扩展模式（type 必须为 'extension'，不可覆盖内置）
   */
  registerExtension(mode: ResponseMode): void {
    if (mode.type !== 'extension') {
      throw new Error(`[Registry] registerExtension requires type='extension', got '${mode.type}' for mode '${mode.id}'`);
    }
    const existing = this.modes.get(mode.id);
    if (existing) {
      if (existing.type === 'builtin') {
        throw new Error(`[Registry] extension '${mode.id}' cannot override builtin mode`);
      }
      throw new Error(`[Registry] extension id '${mode.id}' already registered`);
    }
    this.modes.set(mode.id, mode);
  }

  /**
   * 注销扩展模式（内置模式不可注销）
   */
  unregister(id: string): void {
    const mode = this.modes.get(id);
    if (!mode) return;
    if (mode.type === 'builtin') {
      throw new Error(`[Registry] cannot unregister builtin mode '${id}'`);
    }
    this.modes.delete(id);
  }

  /**
   * 获取指定模式（不存在返回 undefined）
   */
  get(id: string): ResponseMode | undefined {
    return this.modes.get(id);
  }

  /**
   * 列出所有模式（可选按场景过滤）
   */
  list(scene?: 'private' | 'group'): ResponseMode[] {
    const all = Array.from(this.modes.values());
    if (!scene) return all;
    return all.filter(m => m.applicableScenes.includes(scene));
  }

  /**
   * 是否存在指定模式
   */
  has(id: string): boolean {
    return this.modes.has(id);
  }
}
