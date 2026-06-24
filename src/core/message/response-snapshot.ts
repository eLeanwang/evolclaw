/**
 * 响应模式迁移：行为快照探针
 *
 * 用途：迁移前后对比 message-processor 的实际行为是否逐字节一致（防线 1）。
 *
 * 设计：
 *   - 按 (sessionId, taskId) 聚合一条快照，任务处理过程中逐步填充字段
 *   - 任务结束时落盘到 $EVOLCLAW_HOME/data/eck-debug/response-snapshots.jsonl
 *   - 零侵入：探针关闭时所有方法是 no-op，不影响行为
 *   - 仅记录「模式特有决策点」的输入输出，不记录消息内容（隐私 + 体积）
 *
 * 开关：环境变量 RESPONSE_SNAPSHOT=1 启用；默认关闭。
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../../paths.js';
import { appendJsonl } from '../session/session-fs-store.js';
import { logger } from '../../utils/logger.js';

/** 一条消息处理的行为快照 */
export interface BehaviorSnapshot {
  /** 快照采集时间 */
  ts: number;
  msgId?: string;
  sessionId: string;
  taskId: string;
  /** 来源标记：'legacy'=旧逻辑，'plugin'=新插件，'shadow'=影子计算 */
  source: 'legacy' | 'plugin' | 'shadow';

  // ─── 模式决策 ───
  /** chatMode 判定结果 */
  chatMode?: string;
  /** 是否构造了 ProactiveRuntimeState + 参数 */
  proactiveState?: {
    preTool1stMsgChk: boolean;
    toolUseReminder: boolean;
    chatType: string;
  } | null;

  // ─── 流程介入点 ───
  /** policyHook 首工具表态：是否触发 + 是否拦截 */
  policyHook?: { triggered: boolean; blocked: boolean; toolName?: string };
  /** 工具汇报提醒：触发次数 + 是否发了 10 次警告 */
  toolReminder?: { queueReminders: number; tenWarning: boolean };
  /** 标志位检查：是否设置了 lastProactiveFlag */
  flagSet?: boolean;
  /** Unknown skill 兜底：是否触发 */
  unknownSkillFallback?: boolean;
  /** 文件标记处理：处理了哪些文件路径（仅 interactive） */
  fileMarkers?: string[];

  // ─── 出站决策 ───
  /** 每个出站 payload 的 kind + 发送决策 */
  outbound?: Array<{ kind: string; decision: 'sent' | 'suppressed-thought' | 'suppressed-bg' }>;
}

const ENABLED = process.env.RESPONSE_SNAPSHOT === '1';

class SnapshotRecorder {
  /** (sessionId::taskId) → 进行中的快照 */
  private active = new Map<string, BehaviorSnapshot>();
  private outPath: string | null = null;

  private key(sessionId: string, taskId: string): string {
    return `${sessionId}::${taskId}`;
  }

  private getOutPath(): string {
    if (!this.outPath) {
      const dir = path.join(resolvePaths().dataDir, 'eck-debug');
      fs.mkdirSync(dir, { recursive: true });
      this.outPath = path.join(dir, 'response-snapshots.jsonl');
    }
    return this.outPath;
  }

  /** 开始一条快照（beforeProcess 阶段调用） */
  begin(sessionId: string, taskId: string, source: BehaviorSnapshot['source'], msgId?: string): void {
    if (!ENABLED) return;
    this.active.set(this.key(sessionId, taskId), {
      ts: Date.now(), sessionId, taskId, source, msgId,
    });
  }

  /** 填充字段（处理过程中逐步调用） */
  set(sessionId: string, taskId: string, patch: Partial<BehaviorSnapshot>): void {
    if (!ENABLED) return;
    const snap = this.active.get(this.key(sessionId, taskId));
    if (snap) Object.assign(snap, patch);
  }

  /** 向数组字段追加（outbound 等） */
  pushOutbound(sessionId: string, taskId: string, entry: NonNullable<BehaviorSnapshot['outbound']>[number]): void {
    if (!ENABLED) return;
    const snap = this.active.get(this.key(sessionId, taskId));
    if (!snap) return;
    if (!snap.outbound) snap.outbound = [];
    snap.outbound.push(entry);
  }

  /** 结束并落盘（任务收尾时调用） */
  end(sessionId: string, taskId: string): void {
    if (!ENABLED) return;
    const k = this.key(sessionId, taskId);
    const snap = this.active.get(k);
    if (!snap) return;
    this.active.delete(k);
    try {
      appendJsonl(this.getOutPath(), snap);
    } catch (e) {
      logger.debug(`[snapshot] write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  isEnabled(): boolean {
    return ENABLED;
  }
}

/** 全局单例探针 */
export const snapshot = new SnapshotRecorder();
