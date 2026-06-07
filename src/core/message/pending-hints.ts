// 观察者插话：待用提示（pending-hints）存储。
//
// owner 经 observer.inject 给「agent↔对端」会话预埋的提示，落盘为 append-only jsonl，
// 在下一条对端消息到达、渲染该轮 prompt 时一次性消费、注入渲染层。
// 详见 docs/observer-insert-design.md 第一部分（§1.3 文件生命周期 / §1.4 thread 作用域）。
//
// 文件：sessions/<channelType>/<selfAID>/<对端>/pending-hints.jsonl（与 messages.jsonl 同级）
// 每行一个事件：
//   { action:'add',    id, text, threadId, ownerAid, ts }
//   { action:'remove', targetId?, threadId, ts }   // 无 targetId = 撤该 thread 全部
//
// 生命周期 = 一个消费周期（按 (对端,thread) 维度）：
//   - add/remove 追加行（append-only，处理「加了又撤」的竞态：按时间序回放抵消）
//   - consume（对端消息到达触发）：回放算「该 thread」有效集 → 返回 → 清掉该 thread 的事件。
//     · 若文件里其它 thread 仍有未消费提示 → 重写文件只留它们（不误删别的 thread）。
//     · 否则（无其它 thread 残留）→ 删整个文件。
//   - 因为 consume 一次性用掉该 thread 的全部有效提示，消费后该 thread 有效集必然归零，
//     未来状态不依赖消费前历史，故消费即清安全，无需 consume 事件行。
//   - 任何让「整文件」有效集归零的操作都删文件：consume 后无残留即删；remove 把提示全撤光也删。

import fs from 'fs';
import path from 'path';
import { chatDirPath, appendJsonl, readAllJsonlLines } from '../session/session-fs-store.js';
import { logger } from '../../utils/logger.js';
import type { SubMessage } from '../../types.js';

const PENDING_HINTS_FILE = 'pending-hints.jsonl';

export interface HintAddEvent {
  action: 'add';
  id: string;
  text: string;
  threadId: string;     // '' = 主线程
  ownerAid: string;
  ts: number;
}

export interface HintRemoveEvent {
  action: 'remove';
  targetId?: string;    // 缺省 = 撤该 (对端,thread) 全部
  threadId: string;
  ts: number;
}

export type HintEvent = HintAddEvent | HintRemoveEvent;

/** 消费返回的有效提示（已 add、未被 remove，按发送先后排序）。 */
export interface EffectiveHint {
  id: string;
  text: string;
  ownerAid: string;
  ts: number;
}

function hintsPath(sessionsDir: string, channelType: string, channelId: string, selfAID: string): string {
  return path.join(chatDirPath(sessionsDir, channelType, channelId, selfAID), PENDING_HINTS_FILE);
}

/** 归一 threadId：undefined/null → ''（主线程）。 */
function normThread(threadId?: string): string {
  return threadId || '';
}

/**
 * 追加一条 add 事件。返回是否写盘成功（供 ack 判定）。
 * 写盘成功后才回 ack(accepted)——accepted 真正代表"已持久保存"。
 */
export function appendHintAdd(
  sessionsDir: string, channelType: string, channelId: string, selfAID: string,
  hint: { id: string; text: string; threadId?: string; ownerAid: string; ts: number },
): boolean {
  try {
    const fp = hintsPath(sessionsDir, channelType, channelId, selfAID);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const ev: HintAddEvent = {
      action: 'add', id: hint.id, text: hint.text,
      threadId: normThread(hint.threadId), ownerAid: hint.ownerAid, ts: hint.ts,
    };
    appendJsonl(fp, ev);
    return true;
  } catch (e) {
    logger.warn(`[PendingHints] appendHintAdd failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 追加一条 remove 事件。若该操作使 (对端,thread) 有效集归零，则删除整个文件。
 * 返回是否写盘成功（供 ack 判定）。
 */
export function appendHintRemove(
  sessionsDir: string, channelType: string, channelId: string, selfAID: string,
  rm: { targetId?: string; threadId?: string; ts: number },
): boolean {
  try {
    const fp = hintsPath(sessionsDir, channelType, channelId, selfAID);
    if (!fs.existsSync(fp)) return true;  // 无文件 = 无可撤，幂等成功
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const ev: HintRemoveEvent = {
      action: 'remove', threadId: normThread(rm.threadId), ts: rm.ts,
      ...(rm.targetId ? { targetId: rm.targetId } : {}),
    };
    appendJsonl(fp, ev);
    // 撤销后：若全部 thread 的有效集都归零，删文件（不堆死文件）。
    if (!hasAnyEffective(fp)) deleteFile(fp);
    return true;
  } catch (e) {
    logger.warn(`[PendingHints] appendHintRemove failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** 回放整个文件，返回是否还存在任意 thread 的有效提示。 */
function hasAnyEffective(fp: string): boolean {
  const events = readAllJsonlLines<HintEvent>(fp);
  // 按 thread 分组回放
  const byThread = new Map<string, HintEvent[]>();
  for (const ev of events) {
    const t = normThread((ev as any).threadId);
    (byThread.get(t) ?? byThread.set(t, []).get(t)!).push(ev);
  }
  for (const [, evs] of byThread) {
    if (replayEffective(evs).length > 0) return true;
  }
  return false;
}

/** 对单个 thread 的事件序列回放，算出有效提示集（已 add、未被 remove，按 ts 升序）。 */
function replayEffective(events: HintEvent[]): EffectiveHint[] {
  const sorted = events.slice().sort((a, b) => a.ts - b.ts);
  const active = new Map<string, EffectiveHint>();  // id → hint，保插入序
  for (const ev of sorted) {
    if (ev.action === 'add') {
      active.set(ev.id, { id: ev.id, text: ev.text, ownerAid: ev.ownerAid, ts: ev.ts });
    } else {
      if (ev.targetId) active.delete(ev.targetId);
      else active.clear();  // 无 targetId = 撤该 thread 全部
    }
  }
  return [...active.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * 消费 (对端, thread) 的有效提示：回放算「该 thread」有效集 → 返回 → 清掉该 thread。
 *
 * thread 隔离：只消费传入 threadId（归一后）的提示。若文件里其它 thread 仍有未消费提示，
 * 重写文件保留它们；只有当整文件再无任何有效提示时才删除文件。
 * 返回空数组表示该 thread 无有效提示（调用方据此决定是否注入）。
 */
export function consumeHints(
  sessionsDir: string, channelType: string, channelId: string, selfAID: string,
  threadId?: string,
): EffectiveHint[] {
  const fp = hintsPath(sessionsDir, channelType, channelId, selfAID);
  if (!fs.existsSync(fp)) return [];
  let all: HintEvent[];
  try {
    all = readAllJsonlLines<HintEvent>(fp);
  } catch (e) {
    logger.warn(`[PendingHints] consume read failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const wantThread = normThread(threadId);
  const sameThread = all.filter(ev => normThread((ev as any).threadId) === wantThread);
  const effective = replayEffective(sameThread);

  // 其它 thread 仍有未消费提示？若有，重写文件只留它们；否则删整个文件。
  const otherThreadEvents = all.filter(ev => normThread((ev as any).threadId) !== wantThread);
  if (otherThreadEvents.length > 0 && hasEffectiveInEvents(otherThreadEvents)) {
    rewriteFile(fp, otherThreadEvents);
  } else {
    deleteFile(fp);
  }
  return effective;
}

/** events（可能跨多 thread）中是否存在任意有效提示。 */
function hasEffectiveInEvents(events: HintEvent[]): boolean {
  const byThread = new Map<string, HintEvent[]>();
  for (const ev of events) {
    const t = normThread((ev as any).threadId);
    (byThread.get(t) ?? byThread.set(t, []).get(t)!).push(ev);
  }
  for (const [, evs] of byThread) {
    if (replayEffective(evs).length > 0) return true;
  }
  return false;
}

function rewriteFile(fp: string, events: HintEvent[]): void {
  try {
    const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(fp, body);
  } catch (e) {
    logger.warn(`[PendingHints] rewriteFile failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function deleteFile(fp: string): void {
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (e) {
    logger.warn(`[PendingHints] deleteFile failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 仅供 watch / 调试：读出当前 (对端,thread) 有效提示，不消费、不删文件。 */
export function peekHints(
  sessionsDir: string, channelType: string, channelId: string, selfAID: string,
  threadId?: string,
): EffectiveHint[] {
  const fp = hintsPath(sessionsDir, channelType, channelId, selfAID);
  if (!fs.existsSync(fp)) return [];
  try {
    const all = readAllJsonlLines<HintEvent>(fp);
    const wantThread = normThread(threadId);
    return replayEffective(all.filter(ev => normThread((ev as any).threadId) === wantThread));
  } catch {
    return [];
  }
}

// ── 渲染接线纯函数（无 IO，便于单测） ──────────────────────────

/** 把有效提示转成 owner-hint SubMessage（排在对端真实 item 之前，走 inject 渲染模式）。 */
export function hintsToSubMessages(hints: EffectiveHint[]): SubMessage[] {
  return hints.map(h => ({
    kind: 'owner-hint' as const,
    content: h.text,
    ownerAid: h.ownerAid,
    injectTime: h.ts,
    timestamp: h.ts,
  }));
}

/**
 * 渲染失败兜底：把已消费的 owner-hint（提示已从 pending 删除、不可恢复）以纯文本前缀
 * 拼到对端原文之前，避免提示被静默丢弃。仅在 renderMessageBody 抛错或产出空时使用。
 */
export function composeHintFallback(hintItems: SubMessage[], content: string): string {
  if (!hintItems || hintItems.length === 0) return content;
  const lines = hintItems.map(h => `‹owner 提示·已验证›（仅你可见，对端无感）\n${h.content}`);
  return [...lines, content].join('\n\n');
}

// ── observer.inject 请求解析（纯函数：鉴权 + 校验 + 归一，无 IO） ────────────

export type InjectParseResult =
  | { kind: 'reject'; code: 'NOT_OWNER' | 'INVALID_TARGET'; message: string; action: 'add' | 'remove'; injectId?: string }
  | { kind: 'add'; injectId?: string; id: string; text: string; channelId: string; chatType: 'private' | 'group'; threadId?: string; ownerAid: string }
  | { kind: 'remove'; injectId?: string; channelId: string; chatType: 'private' | 'group'; threadId?: string; targetId?: string };

/**
 * 解析 observer.inject payload：鉴权（from∈owners）+ 校验（add 需 channel_id+text；remove 需 channel_id）
 * + 归一字段。纯函数，无副作用——落盘 / ack / watch 由调用方按结果执行。
 * @param ts 用于 add 缺省 id（`inj-<ts>`）；由调用方传入便于测试确定性。
 */
export function parseInjectRequest(
  payload: unknown,
  fromAid: string,
  owners: string[],
  ts: number,
): InjectParseResult {
  const p = (payload && typeof payload === 'object') ? payload as Record<string, any> : {};
  const injectId: string | undefined = typeof p.id === 'string' ? p.id : undefined;
  const action: 'add' | 'remove' = p.action === 'remove' ? 'remove' : 'add';

  if (!owners.includes(fromAid)) {
    return { kind: 'reject', code: 'NOT_OWNER', message: '仅 owner 可插话', action, injectId };
  }

  const target = (p.target && typeof p.target === 'object') ? p.target as Record<string, any> : undefined;
  const channelId: string | undefined = target && typeof target.channel_id === 'string' ? target.channel_id : undefined;
  const text: string = typeof p.text === 'string' ? p.text : '';
  if (!channelId || (action === 'add' && !text.trim())) {
    return { kind: 'reject', code: 'INVALID_TARGET', message: 'target.channel_id 必填；add 还需 text', action, injectId };
  }

  const chatType: 'private' | 'group' = target?.chat_type === 'group' ? 'group' : 'private';
  const threadId: string | undefined = typeof target?.thread_id === 'string' ? target.thread_id : undefined;
  const targetId: string | undefined = typeof p.target_id === 'string' ? p.target_id : undefined;

  if (action === 'remove') {
    return { kind: 'remove', injectId, channelId, chatType, threadId, targetId };
  }
  return { kind: 'add', injectId, id: injectId || `inj-${ts}`, text, channelId, chatType, threadId, ownerAid: fromAid };
}


