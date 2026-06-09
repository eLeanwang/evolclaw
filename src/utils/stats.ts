import fs from 'fs';
import path from 'path';
import { EventBus, GatewayEvent } from '../core/event-bus.js';

interface EventRecord {
  type: string;
  timestamp: number;
  agentName?: string;  // for per-agent bucketing
  durationMs?: number;
  errorType?: string;
  toolName?: string;
}

export interface StatsSnapshot {
  uptimeMs: number;
  lastHour: {
    received: number;
    completed: number;
    errors: number;
    errorsByType: Record<string, number>;
    toolErrors: number;
    toolErrorsByName: Record<string, number>;
    interrupts: number;
    avgResponseMs: number;
  };
}

export class StatsCollector {
  private events: EventRecord[] = [];
  private startTime: number;
  private readonly HOUR_MS = 3_600_000;

  constructor(eventBus: EventBus) {
    this.startTime = Date.now();

    // 订阅相关事件
    eventBus.subscribe('message:received', (event) => {
      const e = event as { timestamp?: number; agentName?: string };
      this.recordEvent({ type: 'received', timestamp: e.timestamp || Date.now(), agentName: e.agentName });
    });

    eventBus.subscribe('task:completed', (event) => {
      const e = event as { timestamp?: number; durationMs?: number; agentName?: string };
      this.recordEvent({ type: 'completed', timestamp: e.timestamp || Date.now(), durationMs: e.durationMs, agentName: e.agentName });
    });

    eventBus.subscribe('task:error', (event) => {
      const e = event as { errorType?: string; agentName?: string };
      this.recordEvent({ type: 'error', timestamp: Date.now(), errorType: e.errorType, agentName: e.agentName });
    });

    eventBus.subscribe('task:interrupted', (event) => {
      const e = event as { agentName?: string };
      this.recordEvent({ type: 'interrupted', timestamp: Date.now(), agentName: e.agentName });
    });

    eventBus.subscribe('tool:result', (event) => {
      const e = event as { isError?: boolean; toolName?: string; agentName?: string };
      if (e.isError) {
        this.recordEvent({ type: 'tool-error', timestamp: Date.now(), toolName: e.toolName, agentName: e.agentName });
      }
    });
  }

  private recordEvent(record: EventRecord): void {
    this.events.push(record);
  }

  /**
   * 获取统计快照。可选 agentName 过滤：未传则全局；传入则只统计该 agent。
   * 自动裁剪 >1h 的事件。
   */
  getSnapshot(agentName?: string): StatsSnapshot {
    const now = Date.now();
    const cutoff = now - this.HOUR_MS;

    // 裁剪过期事件
    this.events = this.events.filter(e => e.timestamp >= cutoff);

    // 聚合统计（可按 agent 过滤）
    const filtered = agentName === undefined
      ? this.events
      : this.events.filter(e => (e.agentName ?? '<unknown>') === agentName);

    let received = 0;
    let completed = 0;
    let errors = 0;
    const errorsByType: Record<string, number> = {};
    let toolErrors = 0;
    const toolErrorsByName: Record<string, number> = {};
    let interrupts = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const event of filtered) {
      switch (event.type) {
        case 'received':
          received++;
          break;
        case 'completed':
          completed++;
          if (event.durationMs !== undefined) {
            totalDuration += event.durationMs;
            durationCount++;
          }
          break;
        case 'error':
          errors++;
          if (event.errorType) {
            errorsByType[event.errorType] = (errorsByType[event.errorType] || 0) + 1;
          }
          break;
        case 'tool-error':
          toolErrors++;
          if (event.toolName) {
            toolErrorsByName[event.toolName] = (toolErrorsByName[event.toolName] || 0) + 1;
          }
          break;
        case 'interrupted':
          interrupts++;
          break;
      }
    }

    return {
      uptimeMs: now - this.startTime,
      lastHour: {
        received,
        completed,
        errors,
        errorsByType,
        toolErrors,
        toolErrorsByName,
        interrupts,
        avgResponseMs: durationCount > 0 ? totalDuration / durationCount : 0
      }
    };
  }
}
export interface AidStatsSnapshot {
  aid: string;
  selfName: string | null;
  messagesReceived: number;
  messagesSent: number;
  systemReceived: number;
  systemSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastReceivedText: string | null;
  lastReceivedFrom: string | null;
  lastReceivedEncrypt: boolean | null;
  lastReceivedChatmode: string | null;
  lastSentText: string | null;
  lastSentTo: string | null;
  lastSentEncrypt: boolean | null;
  lastSentChatmode: string | null;
  uniquePeerCount: number;
  processing: number;
  queued: number;
  lastTaskEnd?: {
    ts: number;
    status: 'completed' | 'error';
    errorType?: string;
    sentDuringTask: boolean;       // 期间是否有 message.send
    thoughtDuringTask: boolean;    // 期间是否有 thought.put
    lastThoughtText?: string;      // 最后一次 thought 的文本（fallback 显示）
    replyCount: number;            // message.send 次数
    thoughtPutCount: number;       // thought.put 次数
    toolUseCount: number;          // 工具调用次数
    numTurns: number;              // 大模型调用次数
    finalText?: string;
    chatmode?: string;
    encrypt?: boolean;
  };
}

interface AidStatsEntry {
  aid: string;
  selfName: string | null;
  messagesReceived: number;
  messagesSent: number;
  systemReceived: number;
  systemSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastReceivedText: string | null;
  lastReceivedFrom: string | null;
  lastReceivedEncrypt: boolean | null;
  lastReceivedChatmode: string | null;
  lastSentText: string | null;
  lastSentTo: string | null;
  lastSentEncrypt: boolean | null;
  lastSentChatmode: string | null;
  uniquePeers: Set<string>;
  currentTaskStartAt: number | null;
  currentTaskReplyCount: number;       // message.send 次数
  currentTaskThoughtPutCount: number;  // thought.put 次数
  currentTaskToolUseCount: number;     // 工具调用次数
  currentTaskNumTurns: number;         // 大模型调用次数
  currentTaskLastThoughtText: string | null;  // 最后一次 thought 文本（用于 fallback 显示）
  currentTaskSessionId: string | null;
  currentTaskChatmode: string | null;
  currentTaskEncrypt: boolean | null;
  lastTaskEnd: AidStatsSnapshot['lastTaskEnd'];
}

export type QueueStatsProvider = (agentName: string) => { processing: number; queued: number };

export interface MessageEventRecord {
  ts: number;
  agent_aid: string;
  peer_key: string;
  direction: 'in' | 'out';
  msg_type?: string;
  bytes: number;
  encrypted?: boolean;
  chatmode?: string;
}

export class AidStatsCollector {
  private entries = new Map<string, AidStatsEntry>();
  private queueStatsProvider?: QueueStatsProvider;
  /** sessionId → 当前正在跑该 session 的 agent，task:started 写入，task:completed/error 清除 */
  private sessionToAgent = new Map<string, string>();
  /** 外部注入的持久化回调（写入 message_events 表） */
  onMessage?: (event: MessageEventRecord) => void;

  constructor(eventBus?: EventBus) {
    if (!eventBus) return;
    eventBus.subscribe('task:started', (event) => {
      const e = event as { agentName?: string; sessionId?: string; encrypt?: boolean; chatmode?: string };
      if (e.agentName) this.onTaskStart(e.agentName, e.encrypt, e.chatmode);
      if (e.agentName && e.sessionId) this.sessionToAgent.set(e.sessionId, e.agentName);
    });
    eventBus.subscribe('task:completed', (event) => {
      const e = event as { agentName?: string; sessionId?: string; finalText?: string; numTurns?: number };
      if (e.agentName) this.onTaskEnd(e.agentName, 'completed', undefined, e.finalText, e.numTurns);
      if (e.sessionId) this.sessionToAgent.delete(e.sessionId);
    });
    eventBus.subscribe('task:error', (event) => {
      const e = event as { agentName?: string; sessionId?: string; errorType?: string };
      if (e.agentName) this.onTaskEnd(e.agentName, 'error', e.errorType);
      if (e.sessionId) this.sessionToAgent.delete(e.sessionId);
    });
    // thought.put 次数 + 最后一次 thought 文本
    // 注意：thought.put 是 fire-and-forget async，可能在 task:completed 之后才到达，
    // 所以同时累加到 currentTask（task 进行中）或 lastTaskEnd（task 已结束但 thought 属于它）
    eventBus.subscribe('message:thought-put', (event) => {
      const e = event as { agentName?: string; text?: string };
      if (!e.agentName) return;
      const entry = this.entries.get(e.agentName);
      if (!entry) return;
      if (entry.currentTaskStartAt != null) {
        // task 进行中
        entry.currentTaskThoughtPutCount++;
        if (e.text) entry.currentTaskLastThoughtText = e.text;
      } else if (entry.lastTaskEnd) {
        // task 已结束，回填到最近一次 task
        entry.lastTaskEnd.thoughtPutCount++;
        entry.lastTaskEnd.thoughtDuringTask = true;
        if (e.text) {
          const t = e.text.length > 100 ? e.text.slice(0, 100) + '…' : e.text;
          entry.lastTaskEnd.lastThoughtText = t;
        }
      }
    });
    // 工具调用次数（tool:use 事件）
    eventBus.subscribe('tool:use', (event) => {
      const e = event as { sessionId?: string };
      if (!e.sessionId) return;
      const agent = this.sessionToAgent.get(e.sessionId);
      if (!agent) return;
      const entry = this.entries.get(agent);
      if (entry && entry.currentTaskStartAt != null) entry.currentTaskToolUseCount++;
    });
  }

  setQueueStatsProvider(provider: QueueStatsProvider): void {
    this.queueStatsProvider = provider;
  }

  private getOrCreate(aid: string): AidStatsEntry {
    let entry = this.entries.get(aid);
    if (!entry) {
      entry = {
        aid,
        selfName: null,
        messagesReceived: 0,
        messagesSent: 0,
        systemReceived: 0,
        systemSent: 0,
        bytesReceived: 0,
        bytesSent: 0,
        lastReceivedAt: null,
        lastSentAt: null,
        lastReceivedText: null,
        lastReceivedFrom: null,
        lastReceivedEncrypt: null,
        lastReceivedChatmode: null,
        lastSentText: null,
        lastSentTo: null,
        lastSentEncrypt: null,
        lastSentChatmode: null,
        uniquePeers: new Set(),
        currentTaskStartAt: null,
        currentTaskReplyCount: 0,
        currentTaskThoughtPutCount: 0,
        currentTaskToolUseCount: 0,
        currentTaskNumTurns: 0,
        currentTaskLastThoughtText: null,
        currentTaskSessionId: null,
        currentTaskChatmode: null,
        currentTaskEncrypt: null,
        lastTaskEnd: undefined,
      };
      this.entries.set(aid, entry);
    }
    return entry;
  }

  private sessionsDir?: string;

  setSessionsDir(dir: string): void {
    this.sessionsDir = dir;
  }

  private onTaskStart(aid: string, encrypt?: boolean, chatmode?: string): void {
    const entry = this.getOrCreate(aid);
    entry.currentTaskStartAt = Date.now();
    entry.currentTaskReplyCount = 0;
    entry.currentTaskThoughtPutCount = 0;
    entry.currentTaskToolUseCount = 0;
    entry.currentTaskNumTurns = 0;
    entry.currentTaskLastThoughtText = null;
    entry.currentTaskChatmode = chatmode ?? null;
    entry.currentTaskEncrypt = encrypt ?? null;
  }

  private onTaskEnd(aid: string, status: 'completed' | 'error', errorType?: string, finalText?: string, numTurns?: number): void {
    const entry = this.getOrCreate(aid);
    const startedAt = entry.currentTaskStartAt;
    const taskEndTs = Date.now();

    // 先用内存计数写入初始值（立即可用）
    const buildTaskEnd = (msgCount: number, thoughtCount: number, lastThought?: string) => ({
      ts: taskEndTs,
      status,
      errorType,
      sentDuringTask: msgCount > 0,
      thoughtDuringTask: thoughtCount > 0,
      lastThoughtText: lastThought,
      replyCount: msgCount,
      thoughtPutCount: thoughtCount,
      toolUseCount: entry.currentTaskToolUseCount,
      numTurns: numTurns ?? entry.currentTaskNumTurns,
      finalText: finalText ? (finalText.length > 100 ? finalText.slice(0, 100) + '…' : finalText) : undefined,
      chatmode: entry.currentTaskChatmode ?? undefined,
      encrypt: entry.currentTaskEncrypt ?? undefined,
    });

    entry.lastTaskEnd = buildTaskEnd(
      entry.currentTaskReplyCount,
      entry.currentTaskThoughtPutCount,
      entry.currentTaskLastThoughtText ?? undefined,
    );

    // 500ms 后从 jsonl 重新统计（覆盖 thought.put 异步延迟问题）
    if (this.sessionsDir && startedAt != null) {
      const sessionsDir = this.sessionsDir;
      const toolUseCount = entry.currentTaskToolUseCount;
      const resolvedNumTurns = numTurns ?? entry.currentTaskNumTurns;
      const chatmode = entry.currentTaskChatmode;
      const encrypt = entry.currentTaskEncrypt;
      setTimeout(() => {
        try {
          const { chatDirPath } = require('../core/session/session-fs-store.js');
          // 找该 aid 下所有 peer 的 messages.jsonl，统计 ts >= startedAt 的出站条目
          const aidDir = path.join(sessionsDir, 'aun', aid.replace(/[/%\\:*?"<>|]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')));
          if (!fs.existsSync(aidDir)) return;
          let msgCount = 0, thoughtCount = 0;
          let lastThoughtText: string | undefined;
          let lastMsgText: string | undefined;
          for (const peerDir of fs.readdirSync(aidDir, { withFileTypes: true })) {
            if (!peerDir.isDirectory() || peerDir.name.startsWith('_')) continue;
            const msgFile = path.join(aidDir, peerDir.name, 'messages.jsonl');
            if (!fs.existsSync(msgFile)) continue;
            const lines = fs.readFileSync(msgFile, 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const rec = JSON.parse(line);
                if (rec.dir !== 'out' || rec.ts < startedAt || rec.ts > taskEndTs + 2000) continue;
                if (rec.msgType === 'thought') {
                  thoughtCount++;
                  if (rec.content) lastThoughtText = rec.content.length > 100 ? rec.content.slice(0, 100) + '…' : rec.content;
                } else if (rec.msgType === 'text') {
                  msgCount++;
                  if (rec.content) lastMsgText = rec.content.length > 100 ? rec.content.slice(0, 100) + '…' : rec.content;
                }
              } catch {}
            }
          }
          const currentEntry = this.entries.get(aid);
          if (currentEntry?.lastTaskEnd?.ts === taskEndTs) {
            currentEntry.lastTaskEnd = {
              ts: taskEndTs,
              status,
              errorType,
              sentDuringTask: msgCount > 0,
              thoughtDuringTask: thoughtCount > 0,
              lastThoughtText: lastThoughtText,
              replyCount: msgCount,
              thoughtPutCount: thoughtCount,
              toolUseCount,
              numTurns: resolvedNumTurns,
              finalText: finalText ? (finalText.length > 100 ? finalText.slice(0, 100) + '…' : finalText) : undefined,
              chatmode: chatmode ?? undefined,
              encrypt: encrypt ?? undefined,
            };
            // 更新 lastSentText 为最后一条 msg（如果有）
            if (lastMsgText && msgCount > 0) {
              currentEntry.lastSentText = lastMsgText;
            }
          }
        } catch {}
      }, 500);
    }

    entry.currentTaskStartAt = null;
    entry.currentTaskReplyCount = 0;
    entry.currentTaskThoughtPutCount = 0;
    entry.currentTaskToolUseCount = 0;
    entry.currentTaskNumTurns = 0;
    entry.currentTaskLastThoughtText = null;
  }

  setSelfName(aid: string, name: string): void {
    const entry = this.getOrCreate(aid);
    entry.selfName = name;
  }

  recordInbound(aid: string, fromPeer: string, byteLength: number, text?: string, isSystem: boolean = false, encrypt?: boolean, chatmode?: string): void {
    const entry = this.getOrCreate(aid);
    if (isSystem) {
      entry.systemReceived++;
    } else {
      entry.messagesReceived++;
      entry.lastReceivedAt = Date.now();
      entry.lastReceivedFrom = fromPeer;
      if (text) entry.lastReceivedText = text.length > 100 ? text.slice(0, 100) + '…' : text;
      if (encrypt != null) entry.lastReceivedEncrypt = encrypt;
      if (chatmode) entry.lastReceivedChatmode = chatmode;
    }
    entry.bytesReceived += byteLength;
    entry.uniquePeers.add(fromPeer);
    // 持久化
    this.onMessage?.({
      ts: Date.now(), agent_aid: aid, peer_key: `aun#${fromPeer}`,
      direction: 'in', msg_type: isSystem ? 'system' : 'private',
      bytes: byteLength, encrypted: encrypt, chatmode,
    });
  }

  recordOutbound(aid: string, toPeer: string, byteLength: number, text?: string, isSystem: boolean = false, encrypt?: boolean, chatmode?: string): void {
    const entry = this.getOrCreate(aid);
    if (isSystem) {
      entry.systemSent++;
    } else {
      entry.messagesSent++;
      entry.lastSentAt = Date.now();
      entry.lastSentTo = toPeer;
      if (text) entry.lastSentText = text.length > 100 ? text.slice(0, 100) + '…' : text;
      if (encrypt != null) entry.lastSentEncrypt = encrypt;
      if (chatmode) entry.lastSentChatmode = chatmode;
      // 累计当前 task 的回复数
      if (entry.currentTaskStartAt != null) {
        entry.currentTaskReplyCount++;
        if (chatmode) entry.currentTaskChatmode = chatmode;
        if (encrypt != null) entry.currentTaskEncrypt = encrypt;
      }
    }
    entry.bytesSent += byteLength;
    entry.uniquePeers.add(toPeer);
    // 持久化
    this.onMessage?.({
      ts: Date.now(), agent_aid: aid, peer_key: `aun#${toPeer}`,
      direction: 'out', msg_type: isSystem ? 'system' : 'private',
      bytes: byteLength, encrypted: encrypt, chatmode,
    });
  }

  getAllSnapshots(): AidStatsSnapshot[] {
    const out: AidStatsSnapshot[] = [];
    for (const entry of this.entries.values()) {
      const queueStats = this.queueStatsProvider
        ? this.queueStatsProvider(entry.aid)
        : { processing: 0, queued: 0 };
      out.push({
        aid: entry.aid,
        selfName: entry.selfName,
        messagesReceived: entry.messagesReceived,
        messagesSent: entry.messagesSent,
        systemReceived: entry.systemReceived,
        systemSent: entry.systemSent,
        bytesReceived: entry.bytesReceived,
        bytesSent: entry.bytesSent,
        lastReceivedAt: entry.lastReceivedAt,
        lastSentAt: entry.lastSentAt,
        lastReceivedText: entry.lastReceivedText,
        lastReceivedFrom: entry.lastReceivedFrom,
        lastReceivedEncrypt: entry.lastReceivedEncrypt,
        lastReceivedChatmode: entry.lastReceivedChatmode,
        lastSentText: entry.lastSentText,
        lastSentTo: entry.lastSentTo,
        lastSentEncrypt: entry.lastSentEncrypt,
        lastSentChatmode: entry.lastSentChatmode,
        uniquePeerCount: entry.uniquePeers.size,
        processing: queueStats.processing,
        queued: queueStats.queued,
        lastTaskEnd: entry.lastTaskEnd,
      });
    }
    return out;
  }
}
