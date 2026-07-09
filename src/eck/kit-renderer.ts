import fs from 'fs';
import path from 'path';
import { eckDebugDir } from '../paths.js';
import { logger } from '../utils/logger.js';
import {
  type Vars, type ManifestSection, type ResolveStatus, type DirOverflow,
  loadManifest, loadManifestMeta, invalidateManifestCache, evaluateWhen, renderTemplate,
  renderLoopSection, resolvePathWithDiag, loadSectionFiles, loadChildTemplate,
  buildPathMappings, shortenPath,
} from './manifest-engine.js';

const DEFAULT_MANIFEST_FILE = 'eck_manifest.json';

export interface KitRenderContext {
  vars: Vars;
  sessionId: string;
}

// ── Caches ──

const _sessionPathCache = new Map<string, Map<string, string>>();

function getSessionCache(sessionId: string): Map<string, string> {
  let cache = _sessionPathCache.get(sessionId);
  if (!cache) { cache = new Map(); _sessionPathCache.set(sessionId, cache); }
  return cache;
}

export function loadKitManifest(): void {
  const sections = loadManifest(DEFAULT_MANIFEST_FILE);
  logger.info(`[KitRenderer] Loaded manifest: ${sections.length} sections`);
}

export function invalidateKitCache(): void {
  invalidateManifestCache();
  _sessionPathCache.clear();
}

export function invalidateSessionCache(sessionId: string): void {
  _sessionPathCache.delete(sessionId);
}

// ── Diagnostics ──

interface SectionDiagnostic {
  id: string;
  description?: string;
  type: 'file' | 'directory';
  rawPath: string;
  pattern?: string;
  needsInjection?: boolean;
  when?: unknown;
  enabled: boolean;
  whenPassed: boolean;
  resolvedPath: string | null;
  resolveStatus: ResolveStatus;
  unresolvedTokens?: string[];
  fileCount: number;
  emptyContent?: boolean;
  used: boolean;
  injected: boolean;
  dirOverflow?: DirOverflow;   // 目录段超单目录限额
  skippedByTotalCap?: boolean; // 因总闸超限未加载
}

// ── Main render ──

/**
 * 渲染单个 section 的一份文件内容。
 * - 有 loop：file 作为 wrapper，加载 childFile，走三段式 renderLoopSection。
 * - 无 loop：needsInjection 则模板渲染，否则原样。
 * 系统提示词层的 loop 数据视为可信（背压信号等），不做 content 哨兵化。
 */
function renderSectionContent(section: ManifestSection, rawContent: string, vars: Vars): string {
  if (section.loop) {
    const childTpl = loadChildTemplate(section.loop.childFile, vars);
    if (childTpl === null) return '';  // child 模板缺失 → 该段落空
    return renderLoopSection(
      rawContent, childTpl, section.loop.forEach, vars,
      /* stripBlankLines */ true, section.loop.separator ?? '\n',
    );
  }
  return section.needsInjection ? renderTemplate(rawContent, vars) : rawContent;
}

export function renderKitSections(ctx: KitRenderContext, manifestFile: string = DEFAULT_MANIFEST_FILE): string {
  const sections = loadManifest(manifestFile);
  const meta = loadManifestMeta(manifestFile);
  const fileParts: string[] = [];
  const fragmentParts: string[] = [];
  const pathMappings = buildPathMappings(ctx.vars);
  const sessionCache = getSessionCache(ctx.sessionId);
  const diagnostics: SectionDiagnostic[] = [];

  // 总闸计数（跨所有段累计）
  let totalFiles = 0;
  let totalBytes = 0;
  let capReached = false;
  const skippedByCap: string[] = [];  // 因总闸超限未加载的 section id

  for (const section of sections) {
    const rawPath = section.type === 'file' ? (section.file ?? '') : (section.path ?? '');
    const diag: SectionDiagnostic = {
      id: section.id, description: section.description, type: section.type, rawPath,
      pattern: section.pattern, needsInjection: section.needsInjection, when: section.when,
      enabled: section.enabled !== false, whenPassed: false, resolvedPath: null,
      resolveStatus: 'no-path', fileCount: 0, used: false, injected: false,
    };

    // 总闸已触发：后续命中的段一律不加载，只记录 id
    if (capReached) {
      diag.skippedByTotalCap = true;
      // 仅当该段本会命中时才计入"未加载"集合（enabled 且 when 通过）
      if (section.enabled !== false && evaluateWhen(section.when, ctx.vars)) {
        diag.whenPassed = true;
        skippedByCap.push(section.id);
      }
      diagnostics.push(diag);
      continue;
    }

    if (section.enabled === false) {
      diag.resolveStatus = 'skipped-disabled';
      diagnostics.push(diag);
      continue;
    }
    diag.whenPassed = evaluateWhen(section.when, ctx.vars);
    if (!diag.whenPassed) {
      diag.resolveStatus = 'skipped-when';
      diagnostics.push(diag);
      continue;
    }

    if (rawPath) {
      const r = resolvePathWithDiag(rawPath, ctx.vars);
      diag.resolvedPath = r.resolved;
      diag.resolveStatus = r.status;
      if (r.unresolvedTokens.length > 0) diag.unresolvedTokens = r.unresolvedTokens;
    }

    const overflowOut: { value?: DirOverflow } = {};
    const files = loadSectionFiles(section, ctx.vars, sessionCache, overflowOut);
    diag.fileCount = files.length;
    if (overflowOut.value) diag.dirOverflow = overflowOut.value;
    // 路径解析成功但读出 0 文件 → 文件/目录不存在（存在性不再单独 syscall，
    // 由内容读取顺带得到；详见 manifest-engine.resolvePathWithDiag）。
    if (files.length === 0) {
      if (diag.resolveStatus === 'ok') diag.resolveStatus = 'not-exist';
      diagnostics.push(diag);
      continue;
    }

    let anyUsed = false;
    for (const [filePath, rawContent] of files) {
      // 总闸检查（文件数 / 字节）：达到即停止本段及后续所有段
      const size = Buffer.byteLength(rawContent, 'utf-8');
      if (totalFiles >= meta.totalMaxFiles || totalBytes + size > meta.totalMaxBytes) {
        capReached = true;
        break;
      }
      const content = renderSectionContent(section, rawContent, ctx.vars);
      if (!content.trim()) { diag.emptyContent = true; continue; }
      const label = section.description ? `${section.id} — ${section.description}` : section.id;
      const displayPath = shortenPath(filePath, pathMappings);
      const part = `Contenu de ${displayPath} (${label}):\n\n${content.trimEnd()}`;
      fileParts.push(part);
      totalFiles += 1;
      totalBytes += size;
      anyUsed = true;
      if (section.needsInjection) { fragmentParts.push(part); diag.injected = true; }
    }

    // 单目录段超限：注入截断说明行
    if (diag.dirOverflow) {
      const ov = diag.dirOverflow;
      const displayPath = shortenPath(diag.resolvedPath ?? rawPath, pathMappings);
      const note = `[注意] 目录 ${displayPath} 未完整加载：${ov.droppedFiles} 个文件未加载` +
        `（达${ov.reason === 'files' ? '文件数' : '字节'}上限 ${ov.limit}${ov.reason === 'bytes' ? ' 字节' : ' 个'}）。`;
      fileParts.push(note);
    }

    diag.used = anyUsed;
    diagnostics.push(diag);
  }

  // 总闸超限：末尾注入总截断说明（含未加载 section id 集合）
  if (capReached && skippedByCap.length > 0) {
    const note = `[注意] 上下文清单总量超限（>${meta.totalMaxFiles} 文件 / >${Math.round(meta.totalMaxBytes / 1024)}KB），` +
      `以下 section 未加载：${skippedByCap.join(', ')}。`;
    fileParts.push(note);
  }

  const body = fileParts.join('\n\n');
  const output = fileParts.length > 0
    ? `<system-reminder>\nEvolClaw Context Kit documents are shown below.\n\n${body}\n\nIMPORTANT: Use this context when it affects the current interaction.\n</system-reminder>`
    : '';
  const fragmentsOutput = fragmentParts.length > 0 ? fragmentParts.join('\n\n') : '';
  writeDebugFiles(ctx, output, fragmentsOutput, diagnostics);
  return output;
}

export function cleanEckDebug(): void {
  const dir = eckDebugDir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist yet */ }
}
// ── Debug output ──

const PARAM_DESCRIPTIONS: Record<string, string> = {
  EVOLCLAW_HOME: '用户数据根目录',
  PACKAGE_ROOT: 'evolclaw 包根目录',
  CURRENT_PROJECT: '当前项目完整路径',
  PERSONAL_DIR: '当前 agent 个人数据目录',
  RELATIONS_DIR: '当前 agent 关系数据目录',
  VENUES_DIR: '当前 agent 环境数据目录',
  selfAid: '当前 agent 的 AID',
  selfName: '当前 agent 的显示名',
  lifecycle: '当前 agent 生命周期（created/bootstrapping/active）',
  isBootstrapping: '当前 agent 是否处于 bootstrap 首次设定阶段',
  hasPersona: '是否有 persona 内容',
  hasWorkingMemory: '是否有 working memory',
  peerId: '对端在该渠道的原生 ID',
  peerKey: '对端跨渠道唯一标识（channel#urlEncode(peerId)）',
  peerName: '对端显示名',
  peerRole: '对端角色（owner/admin/member/visitor/none）',
  peerType: '对端类型（human/agent）',
  sameDevice: '对端与本端同一物理设备（SDK 0.4.9 起明文/密文消息均可携带，具体字段以网关下发为准）',
  sameNetwork: '对端与本端在同一网络内',
  sameEgressIp: '对端与本端共享同一出口 IP',
  groupId: '群组 ID（群聊时）',
  venueKey: '本地环境目录键（channel#urlEncode(groupId)）',
  venueDir: '当前群环境本地目录',
  groupRulesPath: '群规则本地物化文件',
  groupRulesStatus: '群规则同步状态（synced/cached/missing/forbidden/invalid_metadata/file_mismatch/too_large/unreadable/error）',
  groupRulesError: '群规则同步错误',
  chatType: '聊天类型（private=私聊 / group=群聊 / null=本地开发）',
  channel: '渠道类型（aun/feishu/wechat/dingtalk/qqbot/wecom）',
  venueUid: '场所唯一标识（预留）',
  dispatch: '群分发模式（mention=被@才响应 / broadcast=所有消息都响应）',
  clientType: '客户端类型（desktop/web/mobile）',
  permissionMode: '权限模式（auto/bypass/request/edit/plan/noask/readonly）',
  capabilities: '当前渠道支持的能力列表',
  fileCapable: '当前交互模式下是否支持用文件标记发送文件（兼容别名）',
  supportsFileMarker: '当前交互模式下是否支持用文件标记发送文件',
  project: '当前项目目录名',
  sessionId: 'evolclaw 会话 ID',
  sessionName: '会话名称',
  sessionKey: '会话路由键（channelType#urlEncode(channelId)#urlEncode(threadId)）',
  sessionCreatedAt: '会话创建时间（ISO）',
  timezone: 'IANA 时区名（把 ISO 时间戳转本地时间用，如 Asia/Shanghai）',
  tzOffset: '当前 UTC 偏移（如 +08:00）',
  localDate: '当前本地日期（YYYY-MM-DD，按 timezone）',
  weekday: '当前本地星期几（按 timezone+locale）',
  osInfo: '操作系统及版本（如 Windows 11 Pro (win32 10.0.26200)）',
  threadId: '话题 ID（多话题路由时）',
  chatMode: '会话模式（interactive=同步交互 / proactive=主动推送）',
  proactivePreTool1stMsgChk: 'proactive 前置工具首消息检查（true/false）',
  proactiveToolUseReminder: 'proactive 工具调用提醒（true/false）',
  proactiveFirstSendRequired: '当前消息是否要求首次非发送工具前先发送表态',
  proactiveToolReportRequired: '当前消息是否要求按工具调用次数汇报进展',
  proactiveToolReportInterval: 'proactive 工具进展汇报间隔',
  proactiveSendTargetLabel: 'proactive 发送目标标签（对方/群里）',
  readonly: '是否只读模式',
  evolclawMode: 'evolclaw 运行模式（dev=源码仓库可直接修改 | install=全局安装包只读）',
  baseAgent: 'base agent 规范值（claude/codex/gemini/hermes）',
  baseAgentName: 'base agent 显示名',
  baseAgentModel: 'base agent 引擎底座模型（evolclaw 作用域无配置时的兜底）',
  effectiveModel: '当前实际生效模型（关系级 > agent级 > 全局 优先级解析结果）',
  modelFallbackActive: 'evolclaw 配置的模型不可用，当前正在使用降级模型',
  modelFallbackModel: '当前降级使用的 base agent 模型名',
  agentSessionId: 'base agent 会话 ID',
};

function writeDebugFiles(ctx: KitRenderContext, output: string, fragmentsOutput: string, diagnostics: SectionDiagnostic[]): void {
  const now = new Date();
  const ts = now.toISOString().replace(/[T:.]/g, '-').slice(0, 19);
  const dir = eckDebugDir();

  const varsData = {
    timestamp: now.toISOString(),
    sessionId: ctx.sessionId,
    params: Object.entries(ctx.vars)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([name, value]) => ({ name, value, description: PARAM_DESCRIPTIONS[name] || '' })),
  };

  fs.writeFile(path.join(dir, `vars-${ts}.json`), JSON.stringify(varsData, null, 2), () => {});
  if (output) fs.writeFile(path.join(dir, `context-${ts}.md`), output, () => {});
  if (fragmentsOutput) fs.writeFile(path.join(dir, `fragments-${ts}.md`), fragmentsOutput, () => {});
  fs.writeFile(path.join(dir, `manifest-${ts}.md`), formatManifestDiagnostics(ctx, diagnostics), () => {});
}
function formatManifestDiagnostics(ctx: KitRenderContext, diagnostics: SectionDiagnostic[]): string {
  const STATUS_ICON: Record<ResolveStatus, string> = {
    'ok': 'OK',
    'unresolved-vars': 'UNRESOLVED-VARS',
    'not-exist': 'NOT-EXIST',
    'skipped-disabled': 'SKIPPED(disabled)',
    'skipped-when': 'SKIPPED(when)',
    'no-path': 'NO-PATH',
  };

  const used = diagnostics.filter(d => d.used).length;
  const skippedWhen = diagnostics.filter(d => d.resolveStatus === 'skipped-when').length;
  const errors = diagnostics.filter(d => d.resolveStatus === 'unresolved-vars' || d.resolveStatus === 'not-exist').length;

  const lines: string[] = [];
  lines.push(`# ECK Manifest Diagnostics`);
  lines.push('');
  lines.push(`- timestamp: ${new Date().toISOString()}`);
  lines.push(`- sessionId: ${ctx.sessionId}`);
  lines.push(`- sections total: ${diagnostics.length}`);
  lines.push(`- sections used: ${used}`);
  lines.push(`- sections skipped (when=false): ${skippedWhen}`);
  lines.push(`- sections with errors (unresolved-vars/not-exist): ${errors}`);
  lines.push('');

  if (errors > 0) {
    lines.push(`## Errors`);
    lines.push('');
    for (const d of diagnostics) {
      if (d.resolveStatus !== 'unresolved-vars' && d.resolveStatus !== 'not-exist') continue;
      lines.push(`### ${d.id}${d.description ? ' — ' + d.description : ''}`);
      lines.push(`- status: ${STATUS_ICON[d.resolveStatus]}`);
      lines.push(`- type: ${d.type}`);
      lines.push(`- raw path: \`${d.rawPath}\``);
      lines.push(`- resolved: \`${d.resolvedPath ?? '(null)'}\``);
      if (d.unresolvedTokens && d.unresolvedTokens.length > 0) {
        lines.push(`- unresolved tokens: ${d.unresolvedTokens.map(t => '`' + t + '`').join(', ')}`);
      }
      lines.push('');
    }
  }

  lines.push(`## All sections`);
  lines.push('');
  lines.push(`| order | id | status | type | raw path | resolved | files | used | injected |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  diagnostics.forEach((d, idx) => {
    const status = STATUS_ICON[d.resolveStatus];
    const rawPath = d.rawPath ? '`' + d.rawPath + '`' : '—';
    const resolvedShort = d.resolvedPath ? '`' + (d.resolvedPath.length > 60 ? '…' + d.resolvedPath.slice(-58) : d.resolvedPath) + '`' : '—';
    lines.push(`| ${idx + 1} | ${d.id} | ${status} | ${d.type} | ${rawPath} | ${resolvedShort} | ${d.fileCount} | ${d.used ? 'Y' : '·'} | ${d.injected ? 'Y' : '·'} |`);
  });
  lines.push('');

  lines.push(`## Section details`);
  lines.push('');
  for (const d of diagnostics) {
    lines.push(`### ${d.id}${d.description ? ' — ' + d.description : ''}`);
    lines.push(`- status: ${STATUS_ICON[d.resolveStatus]}`);
    lines.push(`- type: ${d.type}`);
    if (d.rawPath) lines.push(`- raw path: \`${d.rawPath}\``);
    if (d.pattern) lines.push(`- pattern: \`${d.pattern}\``);
    if (d.when !== undefined) lines.push(`- when: \`${JSON.stringify(d.when)}\` → ${d.whenPassed ? 'true' : 'false'}`);
    lines.push(`- needsInjection: ${d.needsInjection ? 'true' : 'false'}`);
    lines.push(`- enabled: ${d.enabled}`);
    if (d.resolvedPath) lines.push(`- resolved: \`${d.resolvedPath}\``);
    if (d.unresolvedTokens && d.unresolvedTokens.length > 0) {
      lines.push(`- unresolved tokens: ${d.unresolvedTokens.map(t => '`' + t + '`').join(', ')}`);
    }
    lines.push(`- file count: ${d.fileCount}`);
    if (d.emptyContent) lines.push(`- note: 文件存在但渲染后内容为空`);
    if (d.dirOverflow) {
      lines.push(`- dir overflow: ${d.dirOverflow.droppedFiles} 文件未加载（达${d.dirOverflow.reason === 'files' ? '文件数' : '字节'}上限 ${d.dirOverflow.limit}）`);
    }
    if (d.skippedByTotalCap) lines.push(`- skipped: 总闸超限未加载`);
    lines.push(`- used in output: ${d.used ? 'yes' : 'no'}`);
    lines.push(`- injected as fragment: ${d.injected ? 'yes' : 'no'}`);
    lines.push('');
  }

  return lines.join('\n');
}
