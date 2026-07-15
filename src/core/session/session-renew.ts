import { resolveEffective } from '../../config/config-manager.js';
import { formatPeerKey } from '../relation/peer-identity.js';
import { logger } from '../../utils/logger.js';
import { isTransientProtocolMessage, messageLogPath, type MessageLogEntry } from '../message/message-log.js';
import { readAllJsonlLines } from './session-fs-store.js';
import type { TextInferenceProvider } from '../inference/text-inference.js';
import type { Session, SessionRenewConfig } from '../../types.js';
import type { SessionManager } from './session-manager.js';

export type SessionRenewDecision = 'continue' | 'new';
export type SessionRenewDecisionSource = 'explicit' | 'reply' | 'model' | 'fallback' | 'missing_history';

export interface SessionRenewRequest {
  session: Session;
  channelName: string;
  channelType: string;
  channelId: string;
  selfAid?: string;
  peerId?: string;
  groupId?: string;
  chatType: 'private' | 'group';
  role?: string;
  content: string;
  replyToMessageId?: string | null;
  /** 当前入站是否刚创建了该聊天的首个主 Session。 */
  isNewSession?: boolean;
}

export interface SessionRenewResult {
  session: Session;
  renewed: boolean;
  decision?: SessionRenewDecision;
  source?: SessionRenewDecisionSource;
}

interface SessionRenewModelDecision {
  decision: SessionRenewDecision;
  confidence: number;
  reasonCode?: string;
}

interface SessionRenewModelResult extends SessionRenewModelDecision {
  model: string;
}

interface TextInferenceProviderResolver {
  getTextInferenceProvider(channel?: string, baseagent?: string, selfAid?: string): TextInferenceProvider | undefined;
}

interface RecentDecision {
  candidateSessionId: string;
  selectedSessionId: string;
  decision: SessionRenewDecision;
  source: SessionRenewDecisionSource;
  expiresAt: number;
}

export interface SessionRenewServiceOptions {
  now?: () => number;
  resolveConfig?: (request: SessionRenewRequest) => SessionRenewConfig | undefined;
}

const DEFAULT_AFTER_HOURS = 24;
const DEFAULT_EFFORT = 'low';
const DEFAULT_FALLBACK: SessionRenewDecision = 'continue';
const MAX_CONTEXT_MESSAGES = 40;
const MAX_CONTEXT_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 2_000;
const MODEL_TIMEOUT_MS = 10_000;
const RECENT_DECISION_TTL_MS = 30_000;
const NEW_CONFIDENCE_THRESHOLD = 0.85;
const JUDGE_BASEAGENT = 'claude';

const EXPLICIT_NEW_RE = /^(?:新话题|换个话题|重新开始|新开会话|新会话)[：:，,；;。！!\n]/;
const EXPLICIT_CONTINUE_RE = /^(?:继续上次|延续上次|继续|接着)[：:，,；;。！!\n]/;

const NON_CONVERSATION_TYPES = new Set<MessageLogEntry['msgType']>([
  'command',
  'thought',
  'status',
  'event',
  'tool_call',
  'tool_result',
]);

export function classifyExplicitSessionRenewSignal(content: string): SessionRenewDecision | undefined {
  const normalized = content.trimStart();
  if (EXPLICIT_NEW_RE.test(normalized)) return 'new';
  if (EXPLICIT_CONTINUE_RE.test(normalized)) return 'continue';
  return undefined;
}

export function isSessionRenewConversationEntry(entry: MessageLogEntry, sessionId: string): boolean {
  return entry.sessionId === sessionId
    && !isTransientProtocolMessage(entry)
    && !NON_CONVERSATION_TYPES.has(entry.msgType)
    && entry.content.trim().length > 0;
}

export function selectSessionRenewContext(entries: MessageLogEntry[]): MessageLogEntry[] {
  if (entries.length <= MAX_CONTEXT_MESSAGES) return trimContextByChars(entries);
  const selected = [entries[0], ...entries.slice(-(MAX_CONTEXT_MESSAGES - 1))];
  return trimContextByChars(selected);
}

export function selectLatestHaikuModel(models: string[]): string | undefined {
  let selected: { id: string; major: number; minor: number; date: number } | undefined;

  for (const rawModel of models) {
    const id = rawModel.trim();
    if (!id) continue;
    const leaf = id.toLowerCase().split('/').at(-1) ?? '';
    const tokens = leaf.split('-');
    const haikuIndex = tokens.indexOf('haiku');
    if (haikuIndex < 0) continue;

    const versionTokens = haikuIndex <= 1
      ? tokens.slice(haikuIndex + 1)
      : tokens.slice(1, haikuIndex);
    const versions = versionTokens
      .filter(token => /^\d{1,2}$/.test(token))
      .map(Number);
    const dates = tokens
      .filter(token => /^\d{8}$/.test(token))
      .map(Number);
    const candidate = {
      id,
      major: versions[0] ?? 0,
      minor: versions[1] ?? 0,
      date: dates.length > 0 ? Math.max(...dates) : 0,
    };

    if (!selected
      || candidate.major > selected.major
      || (candidate.major === selected.major && candidate.minor > selected.minor)
      || (candidate.major === selected.major && candidate.minor === selected.minor && candidate.date > selected.date)) {
      selected = candidate;
    }
  }

  return selected?.id;
}

function trimContextByChars(entries: MessageLogEntry[]): MessageLogEntry[] {
  if (entries.length === 0) return [];
  const first = entries[0];
  const tail: MessageLogEntry[] = [];
  let remaining = MAX_CONTEXT_CHARS - Math.min(first.content.length, MAX_MESSAGE_CHARS);

  for (let index = entries.length - 1; index >= 1 && remaining > 0; index--) {
    const entry = entries[index];
    const length = Math.min(entry.content.length, MAX_MESSAGE_CHARS);
    if (tail.length > 0 && length > remaining) break;
    tail.push(entry);
    remaining -= length;
  }

  return [first, ...tail.reverse()];
}

export class SessionRenewService {
  private locks = new Map<string, Promise<void>>();
  private recentDecisions = new Map<string, RecentDecision>();
  private now: () => number;
  private configResolver?: (request: SessionRenewRequest) => SessionRenewConfig | undefined;

  constructor(
    private sessionManager: SessionManager,
    private inferenceProviderResolver: TextInferenceProviderResolver,
    options: SessionRenewServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.configResolver = options.resolveConfig;
  }

  async resolve(request: SessionRenewRequest): Promise<SessionRenewResult> {
    const config = this.resolveConfig(request);
    if (!config || config.enabled !== true) return { session: request.session, renewed: false };

    const routeKey = this.routeKey(request);
    return await this.withLock(routeKey, async () => {
      const cached = this.recentDecisions.get(routeKey);
      if (cached && cached.candidateSessionId === request.session.id && cached.expiresAt > this.now()) {
        const selected = cached.selectedSessionId === request.session.id
          ? request.session
          : await this.sessionManager.getSessionById(cached.selectedSessionId);
        if (selected) {
          selected.identity = request.session.identity;
          return {
            session: selected,
            renewed: cached.decision === 'new',
            decision: cached.decision,
            source: cached.source,
          };
        }
      }

      const active = this.sessionManager.getActiveSessionSync(
        request.channelName,
        request.channelId,
        request.channelType,
        request.selfAid,
      );
      if (active && active.id !== request.session.id) {
        active.identity = request.session.identity;
        return { session: active, renewed: true, decision: 'new', source: 'fallback' };
      }

      return await this.resolveLocked(routeKey, request, config);
    });
  }

  private async resolveLocked(
    routeKey: string,
    request: SessionRenewRequest,
    config: SessionRenewConfig,
  ): Promise<SessionRenewResult> {
    if (request.session.threadId || request.session.processingState) return { session: request.session, renewed: false };

    const afterHours = validPositiveNumber(config.after_hours) ?? DEFAULT_AFTER_HOURS;
    const entries = this.readConversationEntries(request.session);
    const last = entries[entries.length - 1];
    if (!last) {
      if (request.isNewSession) return { session: request.session, renewed: false };
      const idleMs = this.now() - request.session.updatedAt;
      return await this.finishDecision(routeKey, request, 'new', 'missing_history', idleMs);
    }

    const idleMs = this.now() - last.ts;
    if (idleMs <= afterHours * 60 * 60 * 1000) return { session: request.session, renewed: false };

    let source: SessionRenewDecisionSource;
    let decision = classifyExplicitSessionRenewSignal(request.content);
    if (decision) {
      source = 'explicit';
    } else if (
      request.replyToMessageId
      && entries.some(entry => entry.msgId === request.replyToMessageId)
    ) {
      decision = 'continue';
      source = 'reply';
    } else {
      let judgeModel: string | undefined;
      try {
        const provider = this.inferenceProviderResolver.getTextInferenceProvider(
          request.channelName,
          JUDGE_BASEAGENT,
          request.selfAid,
        );
        if (!provider) throw new Error(`text inference provider unavailable: ${JUDGE_BASEAGENT}`);
        const judged = await this.judgeWithModel(request, config, entries, idleMs, provider);
        judgeModel = judged.model;
        decision = judged.decision === 'new' && judged.confidence < NEW_CONFIDENCE_THRESHOLD
          ? 'continue'
          : judged.decision;
        source = 'model';
      } catch (error) {
        decision = config.fallback_action ?? DEFAULT_FALLBACK;
        source = 'fallback';
        logger.warn(`[SessionRenew] judge failed, using fallback=${decision}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return await this.finishDecision(routeKey, request, decision, source, idleMs, judgeModel);
    }

    return await this.finishDecision(routeKey, request, decision, source, idleMs);
  }

  private async finishDecision(
    routeKey: string,
    request: SessionRenewRequest,
    decision: SessionRenewDecision,
    source: SessionRenewDecisionSource,
    idleMs: number,
    judgeModel?: string,
  ): Promise<SessionRenewResult> {
    const selected = decision === 'new'
      ? await this.sessionManager.createRenewedSession(request.session)
      : request.session;
    selected.identity = request.session.identity;

    this.recentDecisions.set(routeKey, {
      candidateSessionId: request.session.id,
      selectedSessionId: selected.id,
      decision,
      source,
      expiresAt: this.now() + RECENT_DECISION_TTL_MS,
    });

    logger.info(
      `[SessionRenew] session=${request.session.id} selected=${selected.id} decision=${decision} source=${source} idleHours=${(idleMs / 3_600_000).toFixed(2)} baseagent=${judgeModel ? JUDGE_BASEAGENT : 'none'} model=${judgeModel || 'none'}`,
    );
    return { session: selected, renewed: decision === 'new', decision, source };
  }

  private resolveConfig(request: SessionRenewRequest): SessionRenewConfig | undefined {
    if (this.configResolver) return this.configResolver(request);
    if (!request.selfAid) return undefined;
    const peerKeyId = request.chatType === 'group'
      ? (request.groupId || request.channelId)
      : (request.peerId || request.channelId);
    const peerKey = formatPeerKey(request.channelType, peerKeyId);
    return resolveEffective({
      self: request.selfAid,
      peerKey,
      role: request.role,
    }, { cache: true }).session_renew;
  }

  private readConversationEntries(session: Session): MessageLogEntry[] {
    const entries = readAllJsonlLines<MessageLogEntry>(messageLogPath(this.sessionManager.getChatDir(session)));
    return entries
      .filter(entry => isSessionRenewConversationEntry(entry, session.id))
      .sort((left, right) => left.ts - right.ts);
  }

  private async judgeWithModel(
    request: SessionRenewRequest,
    config: SessionRenewConfig,
    entries: MessageLogEntry[],
    idleMs: number,
    provider: TextInferenceProvider,
  ): Promise<SessionRenewModelResult> {
    const context = selectSessionRenewContext(entries).map(entry => ({
      dir: entry.dir,
      content: entry.content.slice(0, MAX_MESSAGE_CHARS),
      ts: entry.ts,
      msgType: entry.msgType,
    }));
    const prompt = JSON.stringify({
      old_session_messages: context,
      new_message: request.content,
      reply_to_message_id: request.replyToMessageId || null,
      chat_type: request.chatType,
      idle_hours: Number((idleMs / 3_600_000).toFixed(2)),
    });
    const systemPrompt = [
      'You are a session continuity classifier.',
      'Decide whether the new message continues the old conversation or starts an independent conversation.',
      'Use NEW only when the new intent is clearly independent. When uncertain, choose CONTINUE.',
      'Do not call tools. Do not explain your reasoning.',
      'Return exactly one JSON object: {"decision":"continue|new","confidence":0..1,"reason_code":"short_code"}.',
    ].join('\n');

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        if (!provider.listModels) throw new Error('Claude text inference provider does not expose a model list');
        const models = await provider.listModels(controller.signal);
        const model = selectLatestHaikuModel(models);
        if (!model) throw new Error('Claude model list contains no Haiku model');
        const text = await provider.completeText({
          model,
          effort: config.effort || DEFAULT_EFFORT,
          system: systemPrompt,
          input: prompt,
          signal: controller.signal,
        });
        return { model, text };
      })();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`judge timed out after ${MODEL_TIMEOUT_MS}ms`));
        }, MODEL_TIMEOUT_MS);
      });
      const result = await Promise.race([operation, timeout]);
      return { ...parseModelResult(result.text), model: result.model };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private routeKey(request: SessionRenewRequest): string {
    return [request.channelType, request.selfAid || '', request.channelId, request.session.threadId || ''].join('#');
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

function validPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseModelResult(text: string): SessionRenewModelDecision {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('judge returned no JSON object');
  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  if (parsed.decision !== 'continue' && parsed.decision !== 'new') {
    throw new Error('judge returned invalid decision');
  }
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error('judge returned invalid confidence');
  }
  return {
    decision: parsed.decision,
    confidence: parsed.confidence,
    reasonCode: typeof parsed.reason_code === 'string' ? parsed.reason_code : undefined,
  };
}
