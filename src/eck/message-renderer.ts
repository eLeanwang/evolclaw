// Message rendering layer: render a batch of sub-messages one-by-one through the
// message manifest, then assemble the final body fed to the base agent. Shares the
// manifest-engine primitives with system-prompt rendering, with two key differences:
//   1. The raw message text {{content}} is injected as a LITERAL in the final step,
//      never going through template parsing again (otherwise {{...}} inside a user
//      message would be treated as a template -- garbled at best, injection at worst).
//   2. Blank lines are preserved (multi-paragraph message bodies must not be squashed).

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { eckDebugDir } from '../paths.js';
import { logger } from '../utils/logger.js';
import type { SubMessage } from '../types.js';
import {
  type Vars, loadManifest, evaluateWhen, renderTemplate, loadSectionFiles, defaultModeNames,
} from './manifest-engine.js';

const MESSAGE_MANIFEST_FILE = 'eck_message_manifest.json';

export interface RenderMessageResult {
  body: string;
  /** Flat list of all images across all rendered items, in order. */
  images: Array<{ data: string; mimeType: string }>;
}

// ── time formatting (per IANA timezone) ──

function timeParts(epochMs: number, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const d = new Date(epochMs);
  const p = new Intl.DateTimeFormat('en-US', { ...(timeZone ? { timeZone } : {}), ...opts }).formatToParts(d);
  const out: Record<string, string> = {};
  for (const part of p) out[part.type] = part.value;
  return out;
}

/** "2026-06-04 21:33:07 +08:00" */
export function formatLocalTime(epochMs: number, timeZone?: string): string {
  const g = timeParts(epochMs, timeZone, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const hour = g.hour === '24' ? '00' : g.hour;  // hour12:false may yield "24" at midnight
  const off = timeParts(epochMs, timeZone, { timeZoneName: 'longOffset' }).timeZoneName || '';
  const offset = off.replace(/^GMT/, '') || '+00:00';
  return `${g.year}-${g.month}-${g.day} ${hour}:${g.minute}:${g.second} ${offset}`;
}

// ── single item render ──

function renderOneItem(
  item: SubMessage,
  sessionVars: Vars,
  sessionCache: Map<string, string>,
  contentSentinel: string,
): string {
  const sections = loadManifest(MESSAGE_MANIFEST_FILE);

  // 各 modeType 当前激活的 modeName：agent config.render（经 sessionVars.renderModes 透传）
  // 覆盖 manifest 里标 isDefault 的缺省。详见 docs/observer-insert-design.md 第二部分。
  const defaults = defaultModeNames(sections);
  const configured = (sessionVars.renderModes && typeof sessionVars.renderModes === 'object' && !Array.isArray(sessionVars.renderModes))
    ? sessionVars.renderModes as Record<string, unknown>
    : {};
  const activeMode = (type: string): string | undefined => {
    const c = configured[type];
    if (typeof c === 'string' && c) return c;
    return defaults[type];
  };

  const isOwnerHint = item.kind === 'owner-hint';
  const isHandoff = item.kind === 'handoff';
  const handoffPreviousSentinel = `\x00ECMSG-HANDOFF-PREV-${randomUUID()}\x00`;

  // item-level vars: session vars overlaid with this message's own sender/timestamp.
  const itemVars: Vars = {
    ...sessionVars,
    peerId: item.peerId ?? sessionVars.peerId,
    peerName: item.peerName ?? sessionVars.peerName,
    peerType: item.peerType ?? sessionVars.peerType,
    peerRole: item.peerRole ?? sessionVars.peerRole,
    sameDevice: item.sameDevice ?? sessionVars.sameDevice,
    sameNetwork: item.sameNetwork ?? sessionVars.sameNetwork,
    sameEgressIp: item.sameEgressIp ?? sessionVars.sameEgressIp,
    // 入站加密态（仅 aun 有意义；非 aun 渠道为 undefined）。透传原始布尔：
    // 模板 {{?encrypted=true}}→🔒密文、{{?encrypted=false}}→✉️明文、undefined 两者均落空。
    // 注意：必须传原始布尔（含 false），不能折成 true|undefined，否则 false 分支永不命中。
    encrypted: item.encrypted,
    // 模板引擎不支持数组循环：被 @ 的 AID 预先 join 成串，空则 undefined 使 {{?mentionAids}} 落空。
    mentionAids: (item.mentionAids && item.mentionAids.length > 0) ? item.mentionAids.join(',') : undefined,
    now: formatLocalTime(
      item.timestamp ?? Date.now(),
      sessionVars.timezone ? String(sessionVars.timezone) : undefined,
    ),
    // 渲染模式命中变量（manifest section 的 when 用它选中唯一模式）
    renderMode_private: activeMode('private'),
    renderMode_group: activeMode('group'),
    renderMode_inject: activeMode('inject'),
    // owner 插话提示标记 + 信封头字段
    isOwnerHint,
    ownerAid: isOwnerHint ? (item.ownerAid ?? undefined) : undefined,
    injectTime: isOwnerHint
      ? formatLocalTime(item.injectTime ?? item.timestamp ?? Date.now(), sessionVars.timezone ? String(sessionVars.timezone) : undefined)
      : undefined,
    // msg send 跨会话一次性上下文
    isHandoff,
    handoffKind: item.handoff?.kind,
    handoffOriginChannel: item.handoff?.origin?.channel,
    handoffOriginPeerId: item.handoff?.origin?.peerId,
    handoffOriginThreadId: item.handoff?.origin?.threadId,
    handoffOriginPeerName: item.handoff?.origin?.peerName,
    handoffOriginPeerType: item.handoff?.origin?.peerType,
    handoffOriginRole: item.handoff?.origin?.role,
    handoffPreviousMessageId: item.handoff?.previousMessageId ?? undefined,
    handoffPreviousContent: item.handoff ? handoffPreviousSentinel : undefined,
    handoffReplyCommand: item.handoff?.replyCommand,
    handoffContinueCommand: item.handoff?.continueCommand,
    // content held as a per-call random sentinel, swapped back post-render.
    // Using a UUID means no real message can collide with it.
    content: contentSentinel,
  };

  const out: string[] = [];
  for (const section of sections) {
    if (section.enabled === false) continue;
    if (!evaluateWhen(section.when, itemVars)) continue;
    const files = loadSectionFiles(section, itemVars, sessionCache);
    for (const [, rawContent] of files) {
      const rendered = section.needsInjection
        ? renderTemplate(rawContent, itemVars, /* stripBlankLines */ false)
        : rawContent;
      // swap the sentinel back to the real message text (literal replace, no parsing).
      const withContent = rendered
        .split(contentSentinel).join(item.content)
        .split(handoffPreviousSentinel).join(item.handoff?.previousContent ?? '');
      if (withContent.trim()) out.push(withContent.replace(/\s+$/, ''));
    }
  }
  // if the manifest produced nothing, fall back to raw text -- never drop a message.
  return out.length > 0 ? out.join('\n') : item.content;
}

/**
 * Render each sub-message then assemble the final message body.
 * Also collects all images across items in order, preserving per-item attribution.
 *
 * One item -> single render; many (group batch / same-peer merge) -> each carries
 * its own sender and timestamp.
 */
export function renderMessageBody(
  items: SubMessage[],
  sessionVars: Vars,
  sessionId: string,
): RenderMessageResult {
  if (!items || items.length === 0) return { body: '', images: [] };

  // One random sentinel per renderMessageBody call -- impossible for user text to match.
  const contentSentinel = `\x00ECMSG-${randomUUID()}\x00`;
  const sessionCache = new Map<string, string>();  // render-local cache (template files are small & fixed)

  const renderedParts: string[] = [];
  const allImages: Array<{ data: string; mimeType: string }> = [];

  for (const item of items) {
    renderedParts.push(renderOneItem(item, sessionVars, sessionCache, contentSentinel));
    if (item.images && item.images.length > 0) allImages.push(...item.images);
  }

  const body = renderedParts.join('\n\n');
  writeMessageDebug(sessionId, items, body);
  return { body, images: allImages };
}

// ── Debug ──

function writeMessageDebug(sessionId: string, items: SubMessage[], body: string): void {
  try {
    const ts = new Date().toISOString().replace(/[T:.]/g, '-').slice(0, 19);
    const out = [
      `# Message Render`,
      `- sessionId: ${sessionId}`,
      `- items: ${items.length}`,
      `- images: ${items.reduce((n, i) => n + (i.images?.length ?? 0), 0)}`,
      ``,
      `## Rendered body`,
      ``,
      body,
    ].join('\n');
    fs.writeFile(path.join(eckDebugDir(), `msg-render-${ts}.md`), out, () => {});
  } catch (e) {
    logger.debug(`[MessageRenderer] debug write failed: ${e}`);
  }
}
