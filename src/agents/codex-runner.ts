/**
 * Codex Agent Runner
 *
 * Integrates Codex app-server as an agent backend.
 * Implements the same interface surface as AgentRunner (claude-runner.ts)
 * so MessageProcessor and CommandHandler can work with it transparently.
 */

import type { Config, InteractionRequest } from '../types.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/baseagent-loader.js';
import type { AgentEvent, AgentRunnerFull, AgentRunOverrides, ModelSwitcher, PermissionContext, PermissionModeInfo } from './runner-types.js';
import { checkBlacklist, checkReadonly, checkDangerousCommand, checkHClassWrite, isEvolclawHandoffReturnCommand, requestDangerousCommandPermission, type PermissionGateway } from '../core/permission.js';
import { authorizeEcCommand } from '../core/command/ec-command-permission.js';
import { normalizePermissionMode } from '../core/permission-mode.js';
import { buildCodexHClassFilesystemRules, isSameOrDescendant, resolveProtectedCandidate } from '../core/protected-paths.js';
import { CodexAppServerClient, type CodexServerNotification, type CodexServerRequest, type CodexThreadResponse, type CodexTurnItem } from './codex-app-server-client.js';
import { resolveOpenaiConfig, type OpenaiResolved } from './baseagent.js';
import { logger } from '../utils/logger.js';
import { isRetryableError } from '../utils/error-utils.js';
import { renderActionAsText } from '../core/interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from '../core/message/message-utils.js';
import { resolveCodexCapabilityThreadConfigForProject } from '../core/capability/capability-manager.js';
import { compareVersions } from '../utils/npm-ops.js';
import { resolveRoot } from '../paths.js';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── MIME → 扩展名映射 ──
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ── Codex 模型目录（动态获取，含 effort） ──
interface CodexModelInfo { slug: string; efforts: string[] }

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private done = false;
  private error: Error | null = null;
  private waiting: (() => void) | null = null;

  push(item: T): void {
    if (this.done) return;
    this.queue.push(item);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  fail(error: Error): void {
    this.error = error;
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

interface AppServerStreamState {
  threadId: string;
  turnId?: string;
  streamedAgentMessageIds: Set<string>;
  agentMessageDeltaText: Map<string, string>;
  completedItemIds: Set<string>;
  emittedEditCallIds: Set<string>;
  completedTurnIds: Set<string>;
  tokenUsage?: any;
}

interface TrackedApprovalItem {
  threadId: string;
  turnId: string;
  itemId: string;
  item: Record<string, any>;
}

type CompleteAgentEvent = Extract<AgentEvent, { type: 'complete' }>;
type NormalizedTokenUsage = NonNullable<CompleteAgentEvent['tokenUsage']>;
type NormalizedContextUsage = NonNullable<CompleteAgentEvent['contextUsage']>;
type CodexJsonValue = null | boolean | number | string | CodexJsonValue[] | { [key: string]: CodexJsonValue };
type CodexJsonObject = { [key: string]: CodexJsonValue };

function stableSecurityValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSecurityValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSecurityValue(record[key])}`).join(',')}}`;
}

function externalToolConfigFingerprint(config: Record<string, unknown>): string {
  return createHash('sha256').update(stableSecurityValue(config)).digest('hex');
}

const CODEX_CATALOG_FALLBACK: CodexModelInfo[] = [
  { slug: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.3-codex', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.2', efforts: ['low', 'medium', 'high', 'xhigh'] },
];
let codexCatalogCache: CodexModelInfo[] | null = null;

// The permission bridge is version-locked to the v2 schema audited below:
// named profiles, approvalsReviewer, additional/network approval context, and
// item/permissions/requestApproval must all be present together.
export const MIN_CODEX_CLI_VERSION = '0.144.1';

export interface CodexAppServerAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

export function parseCodexCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

export function isCodexCliVersionSupported(version: string): boolean {
  return compareVersions(version, MIN_CODEX_CLI_VERSION) >= 0;
}

export function getCodexCliVersion(): string | null {
  try {
    const output = execFileSync('codex', ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseCodexCliVersion(output);
  } catch {
    return null;
  }
}

export function getCodexAppServerAvailability(): CodexAppServerAvailability {
  const version = getCodexCliVersion();
  const upgradeHint = '请升级 Codex CLI：npm install -g @openai/codex@latest';
  if (!version) {
    return { available: false, reason: `未检测到可用 Codex CLI。${upgradeHint}` };
  }
  if (!isCodexCliVersionSupported(version)) {
    return {
      available: false,
      version,
      reason: `Codex CLI ${version} 低于最低要求 ${MIN_CODEX_CLI_VERSION}。${upgradeHint}`,
    };
  }

  try {
    execFileSync('codex', ['app-server', '--help'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { available: true, version };
  } catch {
    return { available: false, version, reason: `Codex CLI ${version} 不支持 app-server。${upgradeHint}` };
  }
}

export function isCodexAppServerAvailable(): boolean {
  return getCodexAppServerAvailability().available;
}

function fetchCodexCatalog(): CodexModelInfo[] {
  if (codexCatalogCache) return codexCatalogCache;
  try {
    const output = execFileSync('codex', ['debug', 'models'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const catalog = JSON.parse(output);
    const models = (catalog.models as any[])
      .filter(m => m.visibility === 'list')
      .map(m => ({
        slug: m.slug as string,
        efforts: ((m.supported_reasoning_levels || []) as any[]).map(l => l.effort as string),
      }));
    if (models.length > 0) {
      codexCatalogCache = models;
      return models;
    }
  } catch (e) {
    logger.debug(`[CodexRunner] Failed to fetch model catalog, using fallback: ${e}`);
  }
  return CODEX_CATALOG_FALLBACK;
}

export function getCodexEfforts(model: string): string[] {
  const catalog = fetchCodexCatalog();
  const entry = catalog.find(m => m.slug === model);
  return entry?.efforts ?? catalog[0]?.efforts ?? ['low', 'medium', 'high'];
}

// ── Codex Runner ──

export class CodexRunner implements AgentRunnerFull, ModelSwitcher {
  readonly name = 'codex';
  readonly capabilities: NonNullable<AgentRunnerFull['capabilities']>;
  private model: string;
  private effort?: string;
  private activeAbortControllers = new Map<string, AbortController>();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private activeSessions = new Map<string, string>(); // sessionId → threadId
  private activeTurns = new Map<string, { threadId: string; turnId: string }>();
  private threadProjectPaths = new Map<string, string>();
  private threadExternalToolFingerprints = new Map<string, string>();
  private trackedApprovalItems = new Map<string, TrackedApprovalItem>();
  private pendingInterrupts = new Map<string, number>();
  private appServerClient: CodexAppServerClient | null = null;
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;
  private permissionGateway?: PermissionGateway;
  private sendPromptFn?: (text: string) => Promise<void>;
  private permissionContexts = new Map<string, PermissionContext>();
  private resolvedConfig: OpenaiResolved;
  private readonly pendingInterruptTtlMs = 30_000;

  constructor(config: Config, callbacks: AgentCallbacks) {
    this.resolvedConfig = resolveOpenaiConfig(config);
    this.resolvedConfig.evolclawAgentAid = config.agents?.codex?.evolclawAgentAid;
    this.resolvedConfig.evolclawAgentConfig = config.agents?.codex?.evolclawAgentConfig;
    this.capabilities = {
      clear: false,
      compact: true,
      fork: true,
      // Requires Codex CLI feature flag: default_mode_request_user_input.
      askUserQuestion: this.resolvedConfig.enableRequestUserInput === true,
      // Codex app-server exposes plan streaming, but not Claude-style ExitPlanMode approval.
      planApproval: false,
      // Current file rewind is intentionally degraded: it restores touched files from Git HEAD.
      fileRewind: 'git-head' as const,
    };
    this.model = this.resolvedConfig.model;
    if (this.resolvedConfig.effort) this.effort = this.resolvedConfig.effort;
    this.onSessionIdUpdate = callbacks.onSessionIdUpdate;
  }

  private getAppServerClient(): CodexAppServerClient {
    if (!this.appServerClient) {
      const client = new CodexAppServerClient({
        apiKey: this.resolvedConfig.apiKey,
        baseUrl: this.resolvedConfig.baseUrl,
        model: this.model,
        effort: this.effort,
        enableRequestUserInput: this.resolvedConfig.enableRequestUserInput,
        approvalsReviewer: 'user',
        onServerRequest: request => this.handleAppServerRequest(request),
      });
      client.onNotification(notification => this.trackApprovalItemNotification(notification));
      this.appServerClient = client;
    }
    return this.appServerClient;
  }

  private resetAppServerClient(): void {
    const client = this.appServerClient;
    this.appServerClient = null;
    this.threadExternalToolFingerprints.clear();
    this.trackedApprovalItems.clear();
    client?.close().catch(error => {
      logger.debug(`[CodexRunner] Failed to close stale app-server client: ${error}`);
    });
  }

  private mergeThreadConfig(...configs: Array<Record<string, unknown> | null | undefined>): CodexJsonObject | null {
    const merged: CodexJsonObject = {};
    for (const config of configs) {
      if (!config) continue;
      for (const [key, value] of Object.entries(config)) {
        const current = merged[key];
        if (
          value
          && typeof value === 'object'
          && !Array.isArray(value)
          && current
          && typeof current === 'object'
          && !Array.isArray(current)
        ) {
          merged[key] = this.mergeThreadConfig(current as Record<string, unknown>, value as Record<string, unknown>) ?? {};
        } else {
          merged[key] = value as CodexJsonValue;
        }
      }
    }
    return Object.keys(merged).length > 0 ? merged : null;
  }

  private async resolveCapabilityThreadConfig(projectPath: string): Promise<Record<string, unknown>> {
    const agentConfig = this.resolvedConfig.evolclawAgentConfig;
    if (!agentConfig) return {};
    try {
      return await resolveCodexCapabilityThreadConfigForProject(agentConfig, projectPath, 'codex');
    } catch (error) {
      logger.warn(`[CodexRunner] Failed to resolve Codex capability thread config: ${error}`);
      return {};
    }
  }

  private configRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private projectConfigKeys(
    source: Record<string, unknown>,
    aliases: Record<string, string>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [inputKey, outputKey] of Object.entries(aliases)) {
      const value = source[inputKey];
      if (value !== undefined && value !== null && result[outputKey] === undefined) result[outputKey] = value;
    }
    return result;
  }

  private projectMcpServerConfig(entry: Record<string, unknown>): Record<string, unknown> {
    const projected = this.projectConfigKeys(entry, {
      command: 'command',
      args: 'args',
      env: 'env',
      env_vars: 'env_vars',
      envVars: 'env_vars',
      cwd: 'cwd',
      url: 'url',
      serverUrl: 'url',
      bearer_token_env_var: 'bearer_token_env_var',
      bearerTokenEnvVar: 'bearer_token_env_var',
      http_headers: 'http_headers',
      httpHeaders: 'http_headers',
      env_http_headers: 'env_http_headers',
      envHttpHeaders: 'env_http_headers',
      startup_timeout_sec: 'startup_timeout_sec',
      startupTimeoutSec: 'startup_timeout_sec',
      startup_timeout_ms: 'startup_timeout_ms',
      startupTimeoutMs: 'startup_timeout_ms',
      tool_timeout_sec: 'tool_timeout_sec',
      toolTimeoutSec: 'tool_timeout_sec',
      enabled: 'enabled',
      required: 'required',
      enabled_tools: 'enabled_tools',
      enabledTools: 'enabled_tools',
      disabled_tools: 'disabled_tools',
      disabledTools: 'disabled_tools',
      scopes: 'scopes',
      auth: 'auth',
      oauth_resource: 'oauth_resource',
      oauthResource: 'oauth_resource',
      experimental_environment: 'experimental_environment',
      experimentalEnvironment: 'experimental_environment',
      default_tools_approval_mode: 'default_tools_approval_mode',
      defaultToolsApprovalMode: 'default_tools_approval_mode',
      tools: 'tools',
    });
    const tools = this.configRecord(projected.tools);
    if (tools) {
      projected.tools = Object.fromEntries(Object.entries(tools).map(([tool, config]) => [tool, {
        ...this.projectConfigKeys(this.configRecord(config) ?? {}, {
          enabled: 'enabled',
          approval_mode: 'approval_mode',
          approvalMode: 'approval_mode',
        }),
      }]));
    }
    return projected;
  }

  private projectAppConfig(entry: Record<string, unknown>): Record<string, unknown> {
    const projected = this.projectConfigKeys(entry, {
      enabled: 'enabled',
      approvals_reviewer: 'approvals_reviewer',
      approvalsReviewer: 'approvals_reviewer',
      destructive_enabled: 'destructive_enabled',
      destructiveEnabled: 'destructive_enabled',
      open_world_enabled: 'open_world_enabled',
      openWorldEnabled: 'open_world_enabled',
      default_tools_approval_mode: 'default_tools_approval_mode',
      defaultToolsApprovalMode: 'default_tools_approval_mode',
      default_tools_enabled: 'default_tools_enabled',
      defaultToolsEnabled: 'default_tools_enabled',
      tools: 'tools',
    });
    const tools = this.configRecord(projected.tools);
    if (tools) {
      projected.tools = Object.fromEntries(Object.entries(tools).map(([tool, config]) => [tool, {
        ...this.projectConfigKeys(this.configRecord(config) ?? {}, {
          enabled: 'enabled',
          approval_mode: 'approval_mode',
          approvalMode: 'approval_mode',
        }),
      }]));
    }
    return projected;
  }

  private externalToolPromptPolicy(entry: Record<string, unknown> | undefined, includeReviewer = false): Record<string, unknown> {
    const tools = this.configRecord(entry?.tools);
    return {
      ...(entry ?? {}),
      ...(includeReviewer ? { approvals_reviewer: 'user' } : {}),
      default_tools_approval_mode: 'prompt',
      ...(tools && Object.keys(tools).length > 0 ? {
        tools: Object.fromEntries(Object.entries(tools).map(([tool, config]) => [tool, {
          ...(this.configRecord(config) ?? {}),
          approval_mode: 'prompt',
        }])),
      } : {}),
    };
  }

  private buildExternalToolApprovalConfig(
    effectiveConfig: Record<string, unknown>,
    capabilityConfig: Record<string, unknown>,
    discoveredPluginConfig: Record<string, unknown> = {},
    mode = 'readonly',
  ): Record<string, unknown> {
    const sources = [effectiveConfig, capabilityConfig, discoveredPluginConfig];
    const result: Record<string, unknown> = {};
    const allowExternalTools = mode === 'request' || mode === 'bypass';

    const mcpSections = sources.map(source => this.configRecord(source.mcp_servers)).filter(Boolean) as Record<string, unknown>[];
    const mcpIds = new Set(mcpSections.flatMap(section => Object.keys(section)));
    if (mcpIds.size > 0) {
      const mcpOverrides: Record<string, unknown> = {};
      for (const id of mcpIds) {
        const mergedEntry = this.mergeThreadConfig(...mcpSections.map(section => this.configRecord(section[id]))) ?? {};
        const entry = this.projectMcpServerConfig(mergedEntry);
        const isRemote = typeof entry.url === 'string' || typeof entry.serverUrl === 'string';
        const isStdio = typeof entry.command === 'string' || !isRemote;
        mcpOverrides[id] = isStdio || !allowExternalTools
          ? { ...entry, enabled: false }
          : this.externalToolPromptPolicy(entry as Record<string, unknown>);
      }
      result.mcp_servers = mcpOverrides;
    }

    const appSections = sources.map(source => this.configRecord(source.apps)).filter(Boolean) as Record<string, unknown>[];
    const appIds = new Set(appSections.flatMap(section => Object.keys(section)).filter(id => id !== '_default'));
    const appDefault = this.projectAppConfig(
      this.mergeThreadConfig(...appSections.map(section => this.configRecord(section._default))) ?? {},
    );
    const appOverrides: Record<string, unknown> = {
      _default: this.externalToolPromptPolicy(
        allowExternalTools ? appDefault : { ...appDefault, enabled: false },
        true,
      ),
    };
    for (const id of appIds) {
      const entry = this.projectAppConfig(
        this.mergeThreadConfig(...appSections.map(section => this.configRecord(section[id]))) ?? {},
      );
      appOverrides[id] = this.externalToolPromptPolicy(
        allowExternalTools ? entry : { ...entry, enabled: false },
        true,
      );
    }
    result.apps = appOverrides;

    const pluginSections = sources.map(source => this.configRecord(source.plugins)).filter(Boolean) as Record<string, unknown>[];
    const pluginIds = new Set(pluginSections.flatMap(section => Object.keys(section)));
    const pluginOverrides: Record<string, unknown> = {};
    for (const pluginId of pluginIds) {
      const plugin = this.mergeThreadConfig(...pluginSections.map(section => this.configRecord(section[pluginId]))) ?? {};
      const servers = this.configRecord(plugin.mcp_servers);
      if (!servers) continue;
      pluginOverrides[pluginId] = {
        ...this.projectConfigKeys(plugin, { enabled: 'enabled' }),
        mcp_servers: Object.fromEntries(Object.keys(servers).map(serverId => [serverId, { enabled: false }])),
      };
    }
    if (Object.keys(pluginOverrides).length > 0) result.plugins = pluginOverrides;

    return result;
  }

  private async discoverPluginMcpConfig(
    appServer: CodexAppServerClient,
    projectPath: string,
  ): Promise<Record<string, unknown>> {
    const pluginInstalled = (appServer as any).pluginInstalled;
    const pluginRead = (appServer as any).pluginRead;
    if (typeof pluginInstalled !== 'function' || typeof pluginRead !== 'function') return {};

    const response = await pluginInstalled.call(appServer, projectPath);
    const marketplaces = Array.isArray(response?.marketplaces) ? response.marketplaces : undefined;
    if (!marketplaces) throw new Error('Codex plugin/installed 未返回有效清单，无法建立 plugin MCP 边界');
    if (Array.isArray(response?.marketplaceLoadErrors) && response.marketplaceLoadErrors.length > 0) {
      throw new Error('Codex plugin marketplace 存在加载错误，无法证明 bundled MCP 已全部禁用');
    }

    const plugins: Record<string, unknown> = {};
    for (const marketplace of marketplaces) {
      const summaries = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
      for (const summary of summaries) {
        if (summary?.installed !== true) continue;
        const pluginId = typeof summary.id === 'string' && summary.id
          ? summary.id
          : typeof summary.name === 'string' && summary.name
            ? summary.name
            : undefined;
        const pluginName = typeof summary.name === 'string' && summary.name ? summary.name : pluginId;
        if (!pluginId || !pluginName) {
          throw new Error('Codex 已安装 plugin 缺少稳定标识，无法建立 plugin MCP 边界');
        }
        const detail = await pluginRead.call(appServer, pluginName, {
          name: typeof marketplace?.name === 'string' ? marketplace.name : undefined,
          path: typeof marketplace?.path === 'string' ? marketplace.path : undefined,
        });
        const mcpServers = detail?.plugin?.mcpServers;
        if (!Array.isArray(mcpServers)) {
          throw new Error(`Codex plugin ${pluginId} 未返回 MCP 清单，无法建立外部工具边界`);
        }
        const serverIds = mcpServers.filter((serverId: unknown): serverId is string =>
          typeof serverId === 'string' && serverId.length > 0);
        if (serverIds.length === 0) continue;
        const existing = this.configRecord(plugins[pluginId]) ?? {};
        const existingServers = this.configRecord(existing.mcp_servers) ?? {};
        plugins[pluginId] = {
          ...existing,
          mcp_servers: {
            ...existingServers,
            ...Object.fromEntries(serverIds.map(serverId => [serverId, { enabled: false }])),
          },
        };
      }
    }
    return Object.keys(plugins).length > 0 ? { plugins } : {};
  }

  private async resolveExternalToolApprovalConfig(
    appServer: CodexAppServerClient,
    projectPath: string,
    capabilityConfig: Record<string, unknown>,
    mode = 'readonly',
  ): Promise<Record<string, unknown>> {
    const configRead = (appServer as any).configRead;
    if (typeof configRead !== 'function') {
      return this.buildExternalToolApprovalConfig({}, capabilityConfig, {}, mode);
    }
    const response = await configRead.call(appServer, projectPath);
    const effectiveConfig = this.configRecord(response?.config);
    if (!effectiveConfig) throw new Error('Codex config/read 未返回有效配置，无法建立外部工具审批边界');
    const discoveredPluginConfig = await this.discoverPluginMcpConfig(appServer, projectPath);
    return this.buildExternalToolApprovalConfig(effectiveConfig, capabilityConfig, discoveredPluginConfig, mode);
  }

  // ── ModelSwitcher ──

  setModel(model: string): void { this.model = model; this.resetAppServerClient(); }
  getModel(): string { return this.model; }
  async listModels(): Promise<string[]> {
    try {
      const response = await this.getAppServerClient().modelList(false);
      const ids = (response.data ?? [])
        .map(model => model.id || model.slug || model.name || model.model)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) return ids;
    } catch (error) {
      logger.debug(`[CodexRunner] app-server model/list failed, using catalog fallback: ${error}`);
    }
    return fetchCodexCatalog().map(m => m.slug);
  }

  // ── Effort ──

  setEffort(effort: string | undefined): void { this.effort = effort; this.resetAppServerClient(); }
  getEffort(): string | undefined { return this.effort; }

  // ── Permission ──

  private currentMode: string = 'readonly';
  // per-call/per-session 权限模式：runQuery 按本次解析结果写入，审批回调（异步、按 sessionKey 路由）据此判定。
  // 避免多会话共享 this.currentMode 时的并发污染（与 claude-runner 的 per-call permissionMode 同构）。
  private chatModes = new Map<string, string>();

  /** 将权限模式映射为 Codex app-server 的 approvalPolicy（纯函数，无副作用，供 per-call 派生用）。 */
  private toApprovalPolicy(mode: string): string {
    // `untrusted` guarantees that commands outside Codex's trusted read-only
    // set reach the EvolClaw bridge for EvolClaw's per-mode decision.
    void mode;
    return 'untrusted';
  }

  private permissionProfileName(sessionId: string): string {
    const normalized = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
    if (normalized && normalized === sessionId && normalized.length <= 64) {
      return `__evolclaw_${normalized}_hclass_v1`;
    }

    // Sanitizing and truncating alone can collapse distinct EvolClaw sessions
    // onto one Codex profile (for example `a/b` and `a?b`). Keep a readable
    // prefix, but bind every lossy name to the original session id with a
    // collision-resistant suffix.
    const label = normalized.slice(0, 40) || 'session';
    const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
    return `__evolclaw_${label}_${digest}_hclass_v1`;
  }

  private buildPermissionProfileConfig(sessionId: string, mode: string): Record<string, unknown> {
    const profileName = this.permissionProfileName(sessionId);
    return {
      default_permissions: profileName,
      permissions: {
        [profileName]: {
          extends: mode === 'readonly' ? ':read-only' : ':workspace',
          filesystem: buildCodexHClassFilesystemRules(resolveRoot()),
        },
      },
    };
  }

  private buildLifecycleLockdownConfig(): Record<string, unknown> {
    return {
      features: {
        hooks: false,
      },
    };
  }

  setMode(mode: string): void {
    const normalized = normalizePermissionMode(mode);
    this.currentMode = normalized.mode;
  }
  getMode(): string { return this.currentMode; }
  listModes(): PermissionModeInfo[] {
    return [
      { key: 'readonly', nameZh: '只读', description: '只读操作自动执行，写入直接拒绝', available: true },
      { key: 'auto', nameZh: '自动', description: '常规操作自动执行，危险操作自动拒绝', available: true },
      { key: 'request', nameZh: '审批', description: '需要升级的操作进入人工审批', available: true },
      { key: 'bypass', nameZh: '放行', description: '常规操作自动执行，危险操作仍需审批', available: true },
    ];
  }
  setSendPrompt(fn: (text: string) => Promise<void>): void { this.sendPromptFn = fn; }
  setPermissionContext(sessionId: string, context: PermissionContext): void { this.permissionContexts.set(sessionId, context); }
  setPermissionGateway(gw: PermissionGateway): void { this.permissionGateway = gw; }

  // ── Stream management (needed by MessageProcessor) ──

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(key: string): void {
    this.activeStreams.delete(key);
    this.activeAbortControllers.delete(key);
    this.pendingInterrupts.delete(key);
  }

  hasActiveStream(key: string): boolean {
    return this.activeStreams.has(key) || this.activeAbortControllers.has(key) || this.activeTurns.has(key);
  }

  // ── Core: runQuery ──

  async runQuery(
    sessionId: string,
    prompt: string,
    projectPath: string,
    initialAgentSessionId?: string,
    images?: Array<{ data: string; mimeType?: string }>,
    systemPromptAppend?: string,
    sessionManager?: any,
    modelOverride?: AgentRunOverrides,
    runtimeEnv?: Record<string, string>
  ): Promise<AsyncIterable<AgentEvent>> {
    let agentSessionId = initialAgentSessionId || this.activeSessions.get(sessionId);
    const callModel = modelOverride?.model || this.model;
    const callEffort = modelOverride?.effort ?? this.effort;
    // per-call 权限模式：优先 override（message-processor 解析后传入），缺省回落实例级 currentMode。
    // 写入 chatModes 供异步审批回调按 sessionKey 读取，并据此派生本次 thread 的 approvalPolicy/sandbox，
    // 不依赖共享的 this.approvalPolicy/this.sandboxMode（多会话并发互不污染）。
    const requestedPermissionMode = modelOverride?.permissionMode || this.currentMode;
    const normalizedPermission = normalizePermissionMode(requestedPermissionMode);
    const callMode = normalizedPermission.mode;
    this.chatModes.set(sessionId, callMode);
    const callApprovalPolicy = this.toApprovalPolicy(callMode);
    const permissionProfile = this.permissionProfileName(sessionId);
    const appServer = this.getAppServerClient();
    this.dropExpiredPendingInterrupt(sessionId);

    const effectiveApprovalPolicy = callApprovalPolicy;

    const capabilityConfig = await this.resolveCapabilityThreadConfig(projectPath);
    const externalToolConfig = await this.resolveExternalToolApprovalConfig(appServer, projectPath, capabilityConfig, callMode);
    const threadOptions = {
      model: callModel,
      effort: callEffort,
      approvalPolicy: effectiveApprovalPolicy,
      approvalsReviewer: 'user',
      permissions: permissionProfile,
      config: this.mergeThreadConfig(
        this.buildEvolclawShellEnvironmentConfig(sessionId),
        this.buildPermissionProfileConfig(sessionId, callMode),
        runtimeEnv ? { shell_environment_policy: { set: runtimeEnv } } : undefined,
        capabilityConfig,
        externalToolConfig,
        this.buildLifecycleLockdownConfig(),
      ),
      ...(systemPromptAppend ? { developerInstructions: systemPromptAppend } : {}),
    };

    const threadResponse = agentSessionId
      ? await appServer.threadResume(agentSessionId, projectPath, threadOptions)
      : await appServer.threadStart(projectPath, threadOptions);
    const threadId = threadResponse.thread?.id || agentSessionId;
    if (!threadId) throw new Error('Codex app-server did not return a thread id');

    agentSessionId = threadId;
    this.activeSessions.set(sessionId, threadId);
    this.threadProjectPaths.set(threadId, path.resolve(projectPath));
    this.threadExternalToolFingerprints.set(threadId, externalToolConfigFingerprint(externalToolConfig));
    this.onSessionIdUpdate?.(sessionId, threadId);

    const controller = new AbortController();
    this.activeAbortControllers.set(sessionId, controller);

    const tempFiles: string[] = [];
    const input = this.buildAppServerInput(prompt, images, tempFiles);
    const queue = new AsyncEventQueue<CodexServerNotification>();
    controller.signal.addEventListener('abort', () => queue.end(), { once: true });
    const state: AppServerStreamState = {
      threadId,
      streamedAgentMessageIds: new Set(),
      agentMessageDeltaText: new Map(),
      completedItemIds: new Set(),
      emittedEditCallIds: new Set(),
      completedTurnIds: new Set(),
    };
    const unsubscribe = appServer.onNotification(notification => {
      // 仅从 turn/started 锁定权威 turnId — resume 时会有上一轮 turn 的残留通知
      // （如 thread/tokenUsage/updated）先于新 turn 到达，不能用它们 latch turnId
      const params: any = notification.params || {};
      const notifThreadId = params.threadId ?? params.thread_id;
      if (notifThreadId !== undefined && notifThreadId !== threadId) return;
      if (notification.method === 'turn/started') {
        const startedTurnId = this.extractTurnId(notification);
        if (startedTurnId && !state.turnId) {
          state.turnId = startedTurnId;
          this.activeTurns.set(sessionId, { threadId, turnId: startedTurnId });
          if (this.consumePendingInterrupt(sessionId)) {
            this.interruptAppServerTurn(threadId, startedTurnId).catch(() => {});
            this.activeTurns.delete(sessionId);
          }
        }
      }
      if (!this.isAppServerTurnNotification(notification, state)) return;
      queue.push(notification);
      // 仅在已锁定 turnId 后才允许 turn/completed 结束队列，避免残留的旧 turn/completed 误关
      if (notification.method === 'turn/completed' && state.turnId) queue.end();
    });

    if (this.consumePendingInterrupt(sessionId)) {
      controller.abort('User interrupt');
      this.activeAbortControllers.delete(sessionId);
      this.activeStreams.delete(sessionId);
      logger.info(`[CodexRunner] Applied pending interrupt before turn start: ${sessionId}`);
      return this.transformAppServerStream(queue, sessionId, state, unsubscribe, tempFiles);
    }

    try {
      const turnResponse = await appServer.turnStart(threadId, input, {
        cwd: projectPath,
        model: callModel,
        effort: callEffort,
        approvalPolicy: effectiveApprovalPolicy,
        permissions: permissionProfile,
      });
      const turnId = turnResponse.turn?.id;
      if (turnId && !state.turnId) {
        state.turnId = turnId;
        this.activeTurns.set(sessionId, { threadId, turnId });
      }
      if (turnId && this.consumePendingInterrupt(sessionId)) {
        await this.interruptAppServerTurn(threadId, turnId);
        controller.abort('User interrupt');
        this.activeAbortControllers.delete(sessionId);
        this.activeStreams.delete(sessionId);
        this.activeTurns.delete(sessionId);
      }
      const status = turnResponse.turn?.status;
      if (status === 'completed' || status === 'failed') {
        queue.push({ method: 'turn/completed', params: { threadId, turn: turnResponse.turn as any } });
        queue.end();
      }
    } catch (error) {
      unsubscribe();
      this.activeAbortControllers.delete(sessionId);
      this.activeTurns.delete(sessionId);
      this.pendingInterrupts.delete(sessionId);
      this.cleanupTempFiles(tempFiles);
      throw error;
    }

    return this.transformAppServerStream(queue, sessionId, state, unsubscribe, tempFiles);
  }

  // ── Interrupt ──

  async interrupt(sessionKey: string): Promise<void> {
    const controller = this.activeAbortControllers.get(sessionKey);
    const activeTurn = this.activeTurns.get(sessionKey);
    const hadActiveState = !!controller || !!activeTurn || this.activeStreams.has(sessionKey);
    const interruptTurn = activeTurn
      ? this.interruptAppServerTurn(activeTurn.threadId, activeTurn.turnId)
      : Promise.resolve();

    if (!activeTurn) this.rememberPendingInterrupt(sessionKey);
    if (controller) controller.abort('User interrupt');

    if (hadActiveState) {
      this.activeAbortControllers.delete(sessionKey);
      this.activeStreams.delete(sessionKey);
      this.activeTurns.delete(sessionKey);
      logger.info(`[CodexRunner] Interrupted session: ${sessionKey}`);
    }
    await interruptTurn;
  }

  private rememberPendingInterrupt(sessionId: string): void {
    this.pendingInterrupts.set(sessionId, Date.now());
  }

  private consumePendingInterrupt(sessionId: string): boolean {
    if (!this.pendingInterrupts.has(sessionId)) return false;
    const requestedAt = this.pendingInterrupts.get(sessionId)!;
    this.pendingInterrupts.delete(sessionId);
    return Date.now() - requestedAt <= this.pendingInterruptTtlMs;
  }

  private dropExpiredPendingInterrupt(sessionId: string): void {
    const requestedAt = this.pendingInterrupts.get(sessionId);
    if (requestedAt !== undefined && Date.now() - requestedAt > this.pendingInterruptTtlMs) {
      this.pendingInterrupts.delete(sessionId);
    }
  }

  private async interruptAppServerTurn(threadId: string, turnId: string): Promise<void> {
    try {
      await this.getAppServerClient().turnInterrupt(threadId, turnId);
    } catch (error) {
      logger.debug(`[CodexRunner] app-server turn interrupt failed: ${error}`);
    }
  }

  // ── Session commands ──

  updateSessionId(sessionId: string, agentSessionId: string): void {
    const previousThreadId = this.activeSessions.get(sessionId);
    if (previousThreadId && previousThreadId !== agentSessionId) {
      this.threadProjectPaths.delete(previousThreadId);
      this.threadExternalToolFingerprints.delete(previousThreadId);
      this.clearTrackedApprovalItemsForThread(previousThreadId);
    }
    if (agentSessionId) {
      this.activeSessions.set(sessionId, agentSessionId);
    } else {
      this.activeSessions.delete(sessionId);
    }
    this.onSessionIdUpdate?.(sessionId, agentSessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    const threadId = this.activeSessions.get(sessionId);
    this.activeSessions.delete(sessionId);
    this.activeStreams.delete(sessionId);
    this.activeAbortControllers.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.pendingInterrupts.delete(sessionId);
    this.permissionContexts.delete(sessionId);
    this.chatModes.delete(sessionId);
    if (threadId) {
      this.threadProjectPaths.delete(threadId);
      this.threadExternalToolFingerprints.delete(threadId);
    }
    this.clearTrackedApprovalItemsForThread(threadId);
  }

  resolveSessionFile(agentSessionId: string, _projectPath: string): string | null {
    // Codex session 文件: ~/.codex/sessions/YYYY/MM/DD/rollout-*-{threadId}.jsonl
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;

    // 递归搜索文件名包含 threadId 的 JSONL 文件
    const search = (dir: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const found = search(path.join(dir, entry.name));
          if (found) return found;
        } else if (entry.name.endsWith('.jsonl') && entry.name.includes(agentSessionId)) {
          return path.join(dir, entry.name);
        }
      }
      return null;
    };

    return search(sessionsDir);
  }

  async clearSession(sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    // Codex: 清空会话 = 下次 runQuery 不传 resumeId，自动创建新 thread
    const threadId = this.activeSessions.get(sessionId) ?? _agentSessionId;
    this.activeSessions.delete(sessionId);
    this.chatModes.delete(sessionId);
    this.threadProjectPaths.delete(threadId);
    this.threadExternalToolFingerprints.delete(threadId);
    this.clearTrackedApprovalItemsForThread(threadId);
    this.onSessionIdUpdate?.(sessionId, '');
    return true;
  }

  async compactSession(_sessionId: string, agentSessionId: string, _projectPath: string): Promise<boolean> {
    try {
      const appServer = this.getAppServerClient();
      this.onCompactStart?.(_sessionId);
      try {
        return await this.startAndWaitForCompact(appServer, agentSessionId);
      } catch (error) {
        if (!this.isThreadNotFoundError(error)) throw error;
        logger.info(`[CodexRunner] Compact thread not loaded, resuming before compact: ${agentSessionId}`);
        // 优先用 per-session 模式派生（与 runQuery 一致），缺省回落实例级
        const compactMode = this.chatModes.get(_sessionId) ?? this.currentMode;
        const compactPolicy = this.toApprovalPolicy(compactMode);
        const permissionProfile = this.permissionProfileName(_sessionId);
        const capabilityConfig = await this.resolveCapabilityThreadConfig(_projectPath);
        const externalToolConfig = await this.resolveExternalToolApprovalConfig(appServer, _projectPath, capabilityConfig, compactMode);
        await appServer.threadResume(agentSessionId, _projectPath, {
          model: this.model,
          effort: this.effort,
          approvalPolicy: compactPolicy,
          approvalsReviewer: 'user',
          permissions: permissionProfile,
          config: this.mergeThreadConfig(
            this.buildEvolclawShellEnvironmentConfig(_sessionId),
            this.buildPermissionProfileConfig(_sessionId, compactMode),
            capabilityConfig,
            externalToolConfig,
            this.buildLifecycleLockdownConfig(),
          ),
        });
        this.threadProjectPaths.set(agentSessionId, path.resolve(_projectPath));
        this.threadExternalToolFingerprints.set(agentSessionId, externalToolConfigFingerprint(externalToolConfig));
        return await this.startAndWaitForCompact(appServer, agentSessionId);
      }
    } catch (error) {
      logger.error('[CodexRunner] Compact failed:', error);
      return false;
    }
  }

  async compact(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    return this.compactSession(sessionId, agentSessionId, projectPath);
  }

  private async startAndWaitForCompact(appServer: CodexAppServerClient, threadId: string): Promise<boolean> {
    const completion = this.waitForThreadCompacted(appServer, threadId, Date.now());
    try {
      await appServer.threadCompactStart(threadId);
      await completion.promise;
      return true;
    } finally {
      completion.dispose();
    }
  }

  private waitForThreadCompacted(appServer: CodexAppServerClient, threadId: string, startedAtMs: number): { promise: Promise<void>; dispose: () => void } {
    let unsubscribe: (() => void) | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (resolve: () => void, source: string) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      logger.info(`[CodexRunner] Compact completed for thread: ${threadId} (${source})`);
      unsubscribe?.();
      resolve();
    };
    const promise = new Promise<void>(resolve => {
      unsubscribe = appServer.onNotification(notification => {
        if (notification.method !== 'thread/compacted') return;
        const params: any = notification.params || {};
        const notifThreadId = params.threadId ?? params.thread_id;
        if (notifThreadId !== threadId) return;
        settle(resolve, 'notification');
      });
      pollTimer = setInterval(() => {
        if (this.hasPersistedCompactCompletion(threadId, startedAtMs)) {
          settle(resolve, 'session-log');
        }
      }, 1000);
      pollTimer.unref?.();
    });
    return {
      promise,
      dispose: () => {
        if (pollTimer) clearInterval(pollTimer);
        if (!settled) unsubscribe?.();
      },
    };
  }

  private hasPersistedCompactCompletion(threadId: string, startedAtMs: number): boolean {
    const sessionFile = this.findCodexSessionFile(threadId);
    if (!sessionFile) return false;
    let text = '';
    try {
      text = fs.readFileSync(sessionFile, 'utf8');
    } catch {
      return false;
    }

    const threshold = startedAtMs - 1000;
    for (const line of text.trimEnd().split('\n').reverse()) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;
      if (ts < threshold) break;
      const payloadType = entry.payload?.type;
      if (entry.type === 'compacted' || payloadType === 'context_compacted') return true;
    }
    return false;
  }

  private findCodexSessionFile(threadId: string): string | undefined {
    const root = process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, 'sessions')
      : path.join(process.env.HOME || os.homedir(), '.codex', 'sessions');
    const stack = [root];
    let newest: { path: string; mtimeMs: number } | undefined;
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {
            continue;
          }
          if (!newest || mtimeMs > newest.mtimeMs) newest = { path: fullPath, mtimeMs };
        }
      }
    }
    return newest?.path;
  }

  async forkSession(agentSessionId: string, projectPath: string, title?: string): Promise<string> {
    const sessionKey = this.findSessionKeyByThread(agentSessionId);
    const mode = this.chatModes.get(sessionKey) ?? this.currentMode;
    const permissionProfile = this.permissionProfileName(sessionKey);
    const capabilityConfig = await this.resolveCapabilityThreadConfig(projectPath);
    const appServer = this.getAppServerClient();
    const externalToolConfig = await this.resolveExternalToolApprovalConfig(appServer, projectPath, capabilityConfig, mode);
    const response = await appServer.threadFork(agentSessionId, projectPath, title, {
      model: this.model,
      effort: this.effort,
      approvalPolicy: this.toApprovalPolicy(mode),
      approvalsReviewer: 'user',
      permissions: permissionProfile,
      config: this.mergeThreadConfig(
        this.buildEvolclawShellEnvironmentConfig(sessionKey),
        this.buildPermissionProfileConfig(sessionKey, mode),
        capabilityConfig,
        externalToolConfig,
        this.buildLifecycleLockdownConfig(),
      ),
    });
    const forkedThreadId = response.thread?.id;
    if (!forkedThreadId) throw new Error('Codex fork did not return a thread id');
    this.threadProjectPaths.set(forkedThreadId, path.resolve(projectPath));
    this.threadExternalToolFingerprints.set(forkedThreadId, externalToolConfigFingerprint(externalToolConfig));
    return forkedThreadId;
  }

  async setSessionName(agentSessionId: string, name: string): Promise<boolean> {
    return this.getAppServerClient().threadSetName(agentSessionId, name);
  }

  async updateSessionMetadata(agentSessionId: string, metadata: Record<string, any>): Promise<boolean> {
    const gitInfo = metadata?.gitInfo && typeof metadata.gitInfo === 'object' ? metadata.gitInfo : undefined;
    return this.getAppServerClient().threadMetadataUpdate(agentSessionId, gitInfo);
  }

  async getSessionMessages(agentSessionId: string, projectPath: string): Promise<Array<{
    type: 'user' | 'assistant' | 'system';
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: null;
  }>> {
    const response = await this.getAppServerClient().threadRead(agentSessionId, true);
    return this.mapThreadToSessionMessages(response, agentSessionId);
  }

  private approvalItemKey(threadId: unknown, turnId: unknown, itemId: unknown): string | undefined {
    if (typeof threadId !== 'string' || typeof turnId !== 'string' || typeof itemId !== 'string') return undefined;
    return JSON.stringify([threadId, turnId, itemId]);
  }

  private trackApprovalItemNotification(notification: CodexServerNotification): void {
    const params = (notification.params || {}) as Record<string, any>;
    const item = params.item && typeof params.item === 'object' ? params.item as Record<string, any> : undefined;
    const itemId = item?.id ?? params.itemId;
    const key = this.approvalItemKey(params.threadId, params.turnId, itemId);

    if (notification.method === 'item/started' && key && item) {
      this.trackedApprovalItems.set(key, {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId,
        item: { ...item },
      });
      return;
    }

    if (notification.method === 'item/fileChange/patchUpdated' && key) {
      const tracked = this.trackedApprovalItems.get(key);
      this.trackedApprovalItems.set(key, {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId,
        item: {
          ...(tracked?.item ?? { id: itemId, type: 'fileChange' }),
          changes: params.changes,
        },
      });
      return;
    }

    if (notification.method === 'item/completed' && key) {
      this.trackedApprovalItems.delete(key);
      return;
    }

    if (notification.method === 'turn/completed' && typeof params.threadId === 'string') {
      const completedTurnId = typeof params.turnId === 'string'
        ? params.turnId
        : typeof params.turn?.id === 'string'
          ? params.turn.id
          : undefined;
      for (const [trackedKey, tracked] of this.trackedApprovalItems) {
        if (tracked.threadId === params.threadId && (!completedTurnId || tracked.turnId === completedTurnId)) {
          this.trackedApprovalItems.delete(trackedKey);
        }
      }
    }
  }

  private findTrackedApprovalItem(params: Record<string, any>): Record<string, any> | undefined {
    const key = this.approvalItemKey(params.threadId, params.turnId, params.itemId);
    return key ? this.trackedApprovalItems.get(key)?.item : undefined;
  }

  private clearTrackedApprovalItemsForThread(threadId: string | undefined): void {
    if (!threadId) return;
    for (const [key, tracked] of this.trackedApprovalItems) {
      if (tracked.threadId === threadId) this.trackedApprovalItems.delete(key);
    }
  }

  private async handleAppServerRequest(request: CodexServerRequest): Promise<any> {
    const params = (request.params || {}) as Record<string, any>;
    if (request.method === 'mcpServer/elicitation/request') {
      logger.warn(`[CodexRunner] MCP elicitation cancelled because EvolClaw has no audited elicitation bridge: thread=${params.threadId ?? '<missing>'} server=${params.serverName ?? '<missing>'}`);
      return { action: 'cancel', content: null, _meta: null };
    }
    if (request.method === 'item/tool/requestUserInput') {
      const trackedItem = this.findTrackedApprovalItem(params);
      if (trackedItem?.type === 'mcpToolCall') {
        return this.handleMcpToolApproval(params, trackedItem);
      }
      if (this.looksLikeExternalToolApproval(params.questions)) {
        return this.denyUntrackedExternalToolApproval(params);
      }
      return this.handleToolRequestUserInput(params);
    }

    const approvalMethods = new Set([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'applyPatchApproval',
      'execCommandApproval',
    ]);
    if (!approvalMethods.has(request.method)) {
      throw new Error(`Unsupported Codex app-server request: ${request.method}`);
    }

    const sessionKey = this.findSessionKeyByThread(params.threadId || params.conversationId);
    const toolName = request.method === 'item/permissions/requestApproval'
      ? 'PermissionGrant'
      : request.method.includes('fileChange') || request.method === 'applyPatchApproval'
        ? 'FileChange'
        : 'Bash';
    const toolInput = this.buildPermissionInput(request.method, params);

    // proactive 模式行为策略（首次工具调用必须是 ec msg send）
    const policyResult = this.permissionContexts.get(sessionKey)?.policyHook?.(toolName, toolInput);
    if (policyResult?.block) {
      return this.toAppServerApprovalResponse(request.method, 'deny', toolInput);
    }
    const summary = this.summarizeAppServerRequest(request.method, params);
    const reason = params.reason || params.decisionReason || undefined;
    const workspacePath = this.resolvePermissionWorkspacePath(params);
    if (!workspacePath) {
      logger.warn(`[CodexRunner] approval denied because thread workspace is unknown: method=${request.method} thread=${params.threadId ?? params.conversationId ?? '<missing>'}`);
      return this.toAppServerApprovalResponse(request.method, 'deny', toolInput);
    }
    const operationCwd = this.resolvePermissionOperationCwd(params, workspacePath, toolName);
    const sessionMode = this.chatModes.get(sessionKey) ?? this.currentMode;
    logger.info(`[CodexRunner] app-server approval request id=${request.id} method=${request.method} session=${sessionKey} mode=${sessionMode} tool=${toolName} summary=${summary}`);
    try {
      const decision = await this.resolvePermissionDecision(
        sessionKey,
        toolName,
        toolInput,
        summary,
        reason,
        workspacePath,
        operationCwd,
      );
      const response = this.toAppServerApprovalResponse(request.method, decision, toolInput);
      logger.info(`[CodexRunner] app-server approval response id=${request.id} method=${request.method} decision=${decision} response=${JSON.stringify(response)}`);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[CodexRunner] app-server approval failed id=${request.id} method=${request.method}: ${message}`);
      throw error;
    }
  }

  private classifyMcpApprovalLabel(label: string): 'allow_once' | 'allow_persistent' | 'deny' | 'other' {
    const normalized = label.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    const negative = /\b(decline|deny|reject|cancel|no|block|stop)\b|do not|don't|not\s+(?:accept|approve|allow)|拒绝|不同意|不允许|取消|否|停止/i.test(normalized);
    if (negative) return 'deny';
    const positive = /\b(accept|approve|allow|yes|ok|okay|proceed|continue)\b|同意|允许|批准|确认|继续/i.test(normalized);
    if (!positive) return 'other';
    const persistent = /\b(always|session|chat|conversation|remember|across)\b|don't ask|do not ask|永久|始终|会话|不再询问|记住/i.test(normalized);
    return persistent ? 'allow_persistent' : 'allow_once';
  }

  private selectMcpApprovalAnswer(question: Record<string, any>, allow: boolean): string {
    const options = Array.isArray(question.options) ? question.options : [];
    const labels = options
      .map((option: any) => typeof option?.label === 'string' ? option.label.trim() : '')
      .filter(Boolean);

    if (allow) {
      const oneShot = labels.find(label => this.classifyMcpApprovalLabel(label) === 'allow_once'
        && /\b(once|this time)\b|本次|仅此次/i.test(label));
      if (oneShot) return oneShot;
      const explicit = labels.find(label => this.classifyMcpApprovalLabel(label) === 'allow_once');
      if (explicit) return explicit;
    } else {
      const decline = labels.find(label => this.classifyMcpApprovalLabel(label) === 'deny'
        && !/\bcancel\b|取消/i.test(label));
      if (decline) return decline;
      const cancel = labels.find(label => this.classifyMcpApprovalLabel(label) === 'deny');
      if (cancel) return cancel;
    }

    throw new Error(`Codex MCP 审批缺少可验证的${allow ? '单次允许' : '拒绝'}选项`);
  }

  private looksLikeExternalToolApproval(rawQuestions: unknown): boolean {
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return false;
    return rawQuestions.every(question => {
      if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
      const options = Array.isArray((question as Record<string, any>).options)
        ? (question as Record<string, any>).options
        : [];
      const labels = options
        .map((option: any) => typeof option?.label === 'string' ? option.label : '')
        .filter(Boolean);
      const hasAllow = labels.some((label: string) => {
        const kind = this.classifyMcpApprovalLabel(label);
        return kind === 'allow_once' || kind === 'allow_persistent';
      });
      const hasDeny = labels.some((label: string) => this.classifyMcpApprovalLabel(label) === 'deny');
      return hasAllow && hasDeny;
    });
  }

  private denyUntrackedExternalToolApproval(params: Record<string, any>): Record<string, unknown> {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const questionId = typeof question.id === 'string' ? question.id : `q-${Object.keys(answers).length + 1}`;
      answers[questionId] = { answers: [this.selectMcpApprovalAnswer(question, false)] };
    }
    logger.warn(`[CodexRunner] external tool approval denied because mcpToolCall metadata is missing: thread=${params.threadId ?? '<missing>'} item=${params.itemId ?? '<missing>'}`);
    return { answers };
  }

  private async handleMcpToolApproval(
    params: Record<string, any>,
    trackedItem: Record<string, any>,
  ): Promise<Record<string, unknown>> {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    if (questions.length === 0) throw new Error('Codex MCP 审批未包含问题，已拒绝');

    const hasExactIdentity = typeof trackedItem.server === 'string'
      && trackedItem.server.length > 0
      && typeof trackedItem.tool === 'string'
      && trackedItem.tool.length > 0
      && Object.prototype.hasOwnProperty.call(trackedItem, 'arguments');
    if (!hasExactIdentity) {
      logger.warn(`[CodexRunner] MCP approval denied because exact tool metadata is missing: thread=${params.threadId ?? '<missing>'} item=${params.itemId ?? '<missing>'}`);
      return this.denyUntrackedExternalToolApproval(params);
    }

    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const configFingerprint = threadId ? this.threadExternalToolFingerprints.get(threadId) : undefined;
    if (!configFingerprint) {
      logger.warn(`[CodexRunner] MCP approval denied because the hardened external-tool config is unbound: thread=${threadId ?? '<missing>'}`);
      return this.denyUntrackedExternalToolApproval(params);
    }

    const sessionKey = this.findSessionKeyByThread(params.threadId);
    const server = trackedItem.server as string;
    const tool = trackedItem.tool as string;
    const toolName = `MCP:${server}/${tool}`;
    const toolInput: Record<string, unknown> = {
      server,
      tool,
      arguments: trackedItem.arguments,
      ...(typeof trackedItem.pluginId === 'string' ? { pluginId: trackedItem.pluginId } : {}),
      ...(typeof trackedItem.mcpAppResourceUri === 'string' ? { mcpAppResourceUri: trackedItem.mcpAppResourceUri } : {}),
      ...(trackedItem.appContext && typeof trackedItem.appContext === 'object' ? { appContext: trackedItem.appContext } : {}),
    };
    const policyResult = this.permissionContexts.get(sessionKey)?.policyHook?.(toolName, toolInput);
    const workspacePath = this.resolvePermissionWorkspacePath(params);
    const reason = questions
      .map((question: any) => typeof question?.question === 'string' ? question.question : '')
      .filter(Boolean)
      .join('\n') || 'Codex 请求调用外部 MCP/app 工具';
    const decision = policyResult?.block || !workspacePath
      ? 'deny'
      : await this.resolvePermissionDecision(
        sessionKey,
        toolName,
        toolInput,
        `MCP ${server}/${tool}`,
        policyResult?.reason || reason,
        workspacePath,
        workspacePath,
        `external:${configFingerprint}`,
      );
    let allow = decision !== 'deny';
    if (allow) {
      try {
        for (const question of questions) this.selectMcpApprovalAnswer(question, true);
      } catch {
        allow = false;
        logger.warn(`[CodexRunner] MCP approval denied because Codex offered no one-shot accept option: thread=${params.threadId ?? '<missing>'} item=${params.itemId ?? '<missing>'}`);
      }
    }
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const questionId = typeof question.id === 'string' ? question.id : `q-${Object.keys(answers).length + 1}`;
      answers[questionId] = { answers: [this.selectMcpApprovalAnswer(question, allow)] };
    }
    return { answers };
  }

  private async handleToolRequestUserInput(params: Record<string, any>): Promise<Record<string, unknown>> {
    const sessionKey = this.findSessionKeyByThread(params.threadId);
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const answers: Record<string, { answers: string[] }> = {};

    for (const question of questions) {
      const questionId = typeof question.id === 'string' ? question.id : `q-${Object.keys(answers).length + 1}`;
      answers[questionId] = {
        answers: await this.collectUserInputAnswer(sessionKey, question),
      };
    }

    return { answers };
  }

  private async collectUserInputAnswer(sessionKey: string, question: Record<string, any>): Promise<string[]> {
    const options = Array.isArray(question.options) ? question.options : [];
    const fallback = options[0]?.label ? [String(options[0].label)] : [''];
    const context = this.permissionContexts.get(sessionKey);
    const canFreeText = question.isOther !== false || options.length === 0;
    const sendPrompt = context?.adapter && context.channelId
      ? async (text: string) => context.adapter!.send(buildEnvelope({
        channel: context.adapter!.channelName,
        channelId: context.channelId!,
        replyContext: context.replyContext,
      }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    if (!context?.interactionRouter || !sendPrompt) {
      if (sendPrompt) await sendPrompt(this.formatUserInputFallback(question, fallback));
      return fallback;
    }

    const requestId = `codex-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const buttonArgMap: Record<string, string> = {};
    const buttons = options.length > 0
      ? options.map((option: any, index: number) => {
        const key = `opt-${index}`;
        buttonArgMap[key] = String(index + 1);
        return { key, label: String(option.label || `选项 ${index + 1}`), style: 'default' as const };
      })
      : [{ key: 'custom', label: '提交', style: 'primary' as const }];
    const bodyLines = [String(question.question || '')];
    if (options.some((option: any) => option.description)) {
      bodyLines.push('', ...options.map((option: any, index: number) =>
        `${index + 1}. ${String(option.label || `选项 ${index + 1}`)}${option.description ? ` — ${option.description}` : ''}`));
    }

    const interaction: InteractionRequest = {
      type: 'interaction',
      id: requestId,
      channelId: context.channelId || '',
      sessionId: sessionKey,
      initiatorId: context.userId,
      kind: {
        kind: 'action',
        title: String(question.header || '问题'),
        body: bodyLines.join('\n'),
        buttons,
        allowCustomInput: canFreeText,
      },
      fallback: {
        command: 'ask',
        buttonArgMap,
        acceptFreeText: canFreeText,
        freeTextHint: canFreeText ? '或回复 /ask <自定义内容>' : undefined,
      },
    };

    const router = context.interactionRouter;
    router.markWaiting(sessionKey);
    let waitMarked = true;
    let sent = false;
    try {
      await context.flushPending?.();
      if (context.adapter && context.channelId) {
        const envelope = buildEnvelope({
          taskId: context.taskId,
          channel: context.channel ?? context.adapter.channelName,
          channelId: context.channelId,
          agentName: context.agentName,
          chatmode: context.chatmode,
          replyContext: context.replyContext,
        });
        sent = !!await sendInteractionPayload(context.adapter, envelope, interaction, undefined, context.replyContext);
      }
      if (!sent) {
        await sendPrompt(renderActionAsText(interaction));
        sent = true;
      }
    } catch (error) {
      logger.warn('[CodexRunner] requestUserInput prompt send failed:', error);
    }

    if (!sent) {
      router.unmarkWaiting(sessionKey);
      return fallback;
    }

    return new Promise<string[]>((resolve) => {
      router.register(requestId, sessionKey, (action: string, values?: Record<string, any>) => {
        resolve(this.parseUserInputAction(action, values, options, fallback));
      }, {
        initiatorId: context.userId,
        fallbackCommand: 'ask',
      });
      if (waitMarked) {
        router.unmarkWaiting(sessionKey);
        waitMarked = false;
      }
    });
  }

  private parseUserInputAction(action: string, values: Record<string, any> | undefined, options: any[], fallback: string[]): string[] {
    if (action === '_custom_input') {
      const customText = typeof values?.custom_text === 'string' ? values.custom_text.trim() : '';
      return customText ? [customText] : fallback;
    }
    if (action.startsWith('opt-')) {
      const index = Number.parseInt(action.slice(4), 10);
      const label = options[index]?.label;
      return label ? [String(label)] : fallback;
    }
    const selected = action.split(',').map(part => part.trim()).filter(Boolean);
    if (selected.length > 0 && selected.every(part => /^\d+$/.test(part))) {
      const labels = selected
        .map(part => options[Number.parseInt(part, 10) - 1]?.label)
        .filter((label): label is string => typeof label === 'string' && label.length > 0);
      if (labels.length > 0) return labels;
    }
    return action.trim() ? [action.trim()] : fallback;
  }

  private formatUserInputFallback(question: Record<string, any>, fallback: string[]): string {
    const options = Array.isArray(question.options) ? question.options : [];
    const lines = [String(question.header || '问题'), String(question.question || '')].filter(Boolean);
    if (options.length > 0) {
      lines.push('', ...options.map((option: any, index: number) =>
        `${index + 1}. ${String(option.label || `选项 ${index + 1}`)}${option.description ? ` — ${option.description}` : ''}`));
    }
    lines.push('', `自动选择：${fallback.join(', ')}`);
    return lines.join('\n');
  }

  private findSessionKeyByThread(threadId?: string): string {
    if (threadId) {
      for (const [sessionKey, activeThreadId] of this.activeSessions.entries()) {
        if (activeThreadId === threadId) return sessionKey;
      }
    }
    return threadId || 'codex-app-server';
  }

  private buildPermissionInput(method: string, params: Record<string, any>): Record<string, unknown> {
    if (method === 'item/permissions/requestApproval') {
      return { permissions: params.permissions, cwd: params.cwd, reason: params.reason };
    }
    const trackedItem = this.findTrackedApprovalItem(params);
    if (method.includes('fileChange') || method === 'applyPatchApproval') {
      return {
        fileChanges: params.fileChanges ?? trackedItem?.changes,
        grantRoot: params.grantRoot,
        reason: params.reason,
      };
    }
    const rawCommand = params.command ?? trackedItem?.command;
    const command = Array.isArray(rawCommand) ? rawCommand.join(' ') : (rawCommand || '');
    return {
      command,
      ...(Array.isArray(rawCommand) ? { commandArgv: rawCommand } : {}),
      cwd: params.cwd ?? trackedItem?.cwd,
      reason: params.reason,
      commandActions: params.commandActions || params.parsedCmd || trackedItem?.commandActions,
      additionalPermissions: params.additionalPermissions,
      networkApprovalContext: params.networkApprovalContext,
      proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
      environmentId: params.environmentId,
    };
  }

  private summarizeAppServerRequest(method: string, params: Record<string, any>): string {
    if (method === 'item/permissions/requestApproval') {
      return params.reason || '运行时权限升级';
    }
    if (method.includes('fileChange') || method === 'applyPatchApproval') {
      if (params.grantRoot) return '允许写入：' + params.grantRoot;
      const trackedItem = this.findTrackedApprovalItem(params);
      const changes = this.normalizeFileChanges(params.fileChanges ?? trackedItem?.changes);
      const descriptions = changes.map(change => this.describeFileChange(change)).filter(Boolean);
      return descriptions.length ? descriptions.join(', ') : '文件变更审批';
    }
    const networkContext = params.networkApprovalContext;
    if (networkContext && typeof networkContext === 'object' && !Array.isArray(networkContext)) {
      const host = typeof networkContext.host === 'string' ? networkContext.host : '';
      const protocol = typeof networkContext.protocol === 'string' ? networkContext.protocol : '';
      if (host) return `允许网络访问：${protocol ? `${protocol}://` : ''}${host}`;
    }
    const trackedItem = this.findTrackedApprovalItem(params);
    const rawCommand = params.command ?? trackedItem?.command;
    const command = Array.isArray(rawCommand) ? rawCommand.join(' ') : rawCommand;
    return command || '命令执行审批';
  }

  private resolvePermissionWorkspacePath(params: Record<string, any>): string | undefined {
    const threadId = typeof params.threadId === 'string'
      ? params.threadId
      : typeof params.conversationId === 'string'
        ? params.conversationId
        : undefined;
    if (threadId) {
      const threadProjectPath = this.threadProjectPaths.get(threadId);
      if (threadProjectPath) return threadProjectPath;
    }
    return undefined;
  }

  private resolvePermissionOperationCwd(
    params: Record<string, any>,
    workspacePath: string,
    toolName: string,
  ): string {
    if (toolName === 'FileChange') return resolveProtectedCandidate(workspacePath);
    const trackedItem = this.findTrackedApprovalItem(params);
    const rawCwd = typeof params.cwd === 'string' && params.cwd
      ? params.cwd
      : typeof trackedItem?.cwd === 'string' && trackedItem.cwd
        ? trackedItem.cwd
        : undefined;
    if (!rawCwd) return resolveProtectedCandidate(workspacePath);
    const absolute = path.isAbsolute(rawCwd) ? rawCwd : path.resolve(workspacePath, rawCwd);
    return resolveProtectedCandidate(absolute);
  }

  private checkCodexReadonly(
    toolName: string,
    input: Record<string, unknown>,
    projectPath: string,
    sessionKey?: string
  ): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
    const permCtx = sessionKey ? this.permissionContexts.get(sessionKey) : undefined;
    const readonlyContext = sessionKey ? {
      sessionId: sessionKey,
      channel: permCtx?.channel,
      peerId: permCtx?.userId,
      role: undefined  // codex doesn't track role in session
    } : undefined;

    if (toolName === 'Bash') return checkReadonly(toolName, input, projectPath, readonlyContext);
    return { behavior: 'deny', message: '🔒 只读模式：权限升级和文件写入请求已拒绝' };
  }

  private hasAdditionalPermissionRequest(input: Record<string, unknown>): boolean {
    const permissions = input.additionalPermissions;
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;
    const profile = permissions as Record<string, unknown>;
    const network = profile.network;
    if (network && typeof network === 'object' && !Array.isArray(network)) {
      if ((network as Record<string, unknown>).enabled === true) return true;
    }
    const fileSystem = profile.fileSystem;
    if (!fileSystem || typeof fileSystem !== 'object' || Array.isArray(fileSystem)) return false;
    const fsProfile = fileSystem as Record<string, unknown>;
    if (Array.isArray(fsProfile.read) && fsProfile.read.length > 0) return true;
    if (Array.isArray(fsProfile.write) && fsProfile.write.length > 0) return true;
    return Array.isArray(fsProfile.entries) && fsProfile.entries.some(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      return (entry as Record<string, unknown>).access !== 'deny';
    });
  }

  private hasNetworkPermissionRequest(input: Record<string, unknown>): boolean {
    const context = input.networkApprovalContext;
    if (context && typeof context === 'object' && !Array.isArray(context)) {
      const record = context as Record<string, unknown>;
      if (typeof record.host === 'string' && record.host.length > 0) return true;
    }
    return Array.isArray(input.proposedNetworkPolicyAmendments)
      && input.proposedNetworkPolicyAmendments.length > 0;
  }

  private fileChangeRequiresExpansion(input: Record<string, unknown>, projectPath: string): boolean {
    if (typeof input.grantRoot === 'string' && input.grantRoot.length > 0) return true;
    const paths: string[] = [];
    for (const change of this.normalizeFileChanges(input.fileChanges)) {
      for (const candidate of [
        change?.path,
        change?.move_path,
        change?.movePath,
        change?.kind?.move_path,
        change?.kind?.movePath,
      ]) {
        if (typeof candidate === 'string' && candidate.length > 0) paths.push(candidate);
      }
    }
    if (paths.length === 0) return true;
    const workspace = resolveProtectedCandidate(projectPath);
    return paths.some(candidate => {
      const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspace, candidate);
      const canonical = resolveProtectedCandidate(absolute);
      return !isSameOrDescendant(canonical, workspace);
    });
  }

  private async resolvePermissionDecision(
    sessionKey: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    summary: string,
    reason?: string,
    workspacePath = process.cwd(),
    operationCwd = workspacePath,
    grantScopeSuffix?: string,
  ): Promise<'allow' | 'always' | 'deny'> {
    const blacklist = await checkBlacklist(toolName, toolInput);
    if (blacklist.behavior === 'deny') return 'deny';

    const permissionContext = this.permissionContexts.get(sessionKey);
    const permissionPrompt = permissionContext?.sendPrompt ?? this.sendPromptFn;
    const hClass = checkHClassWrite(toolName, blacklist.updatedInput, {
      sessionId: sessionKey,
      channel: permissionContext?.channel,
      peerId: permissionContext?.userId,
      role: permissionContext?.role,
      projectPath: operationCwd,
      workspacePath,
    });
    if (hClass.behavior === 'deny') return 'deny';

    const hasAdditionalPermissions = toolName === 'Bash'
      && this.hasAdditionalPermissionRequest(blacklist.updatedInput);
    const hasNetworkPermissions = toolName === 'Bash'
      && this.hasNetworkPermissionRequest(blacklist.updatedInput);
    const hasPermissionExpansion = hasAdditionalPermissions || hasNetworkPermissions;
    const hasFileChangeExpansion = toolName === 'FileChange'
      && this.fileChangeRequiresExpansion(blacklist.updatedInput, workspacePath);

    if (toolName === 'FileChange') {
      const hasGrantRoot = typeof blacklist.updatedInput.grantRoot === 'string'
        && blacklist.updatedInput.grantRoot.length > 0;
      const hasConcreteChanges = this.normalizeFileChanges(blacklist.updatedInput.fileChanges)
        .some(change => typeof change?.path === 'string' && change.path.length > 0);
      if (!hasGrantRoot && !hasConcreteChanges) return 'deny';
    }

    if (toolName === 'Bash' && !hasPermissionExpansion) {
      const command = typeof blacklist.updatedInput.command === 'string'
        ? blacklist.updatedInput.command.trim()
        : '';
      if (!command) return 'deny';
    }

    if (toolName === 'Bash' && !hasPermissionExpansion) {
      const command = typeof blacklist.updatedInput.command === 'string' ? blacklist.updatedInput.command : '';
      if (isEvolclawHandoffReturnCommand(command)) return 'allow';
      const ecDecision = authorizeEcCommand(command, {
        actorId: permissionContext?.userId,
        channel: permissionContext?.channel,
        channelId: permissionContext?.channelId,
        chatType: permissionContext?.chatType,
        selfAid: permissionContext?.selfAid,
        peerKey: permissionContext?.peerKey,
        role: permissionContext?.role || 'none',
        isDaemonOwner: false,
        fromControlChannel: permissionContext?.channel?.startsWith('control#') || false,
      });
      if (ecDecision) {
        if (!ecDecision.allow) return 'deny';
        return 'allow';
      }
    }

    // per-session 权限模式（runQuery 写入）；缺省回落实例级 currentMode（兼容无 runQuery 上下文的调用）
    const rawMode = this.chatModes.get(sessionKey) ?? this.currentMode;
    const mode = normalizePermissionMode(rawMode).mode;
    const baseGrantScope = `codex:${this.permissionProfileName(sessionKey)}:${mode}`;
    const grantScope = grantScopeSuffix ? `${baseGrantScope}:${grantScopeSuffix}` : baseGrantScope;

    if (mode === 'readonly') {
      const readonly = this.checkCodexReadonly(toolName, blacklist.updatedInput, operationCwd, sessionKey);
      if (readonly.behavior === 'deny') return 'deny';
      return 'allow';
    }

    if (toolName.startsWith('MCP:')) {
      if (mode === 'auto') return 'deny';
      if (!this.permissionGateway || !permissionPrompt) return 'deny';
      return this.permissionGateway.requestPermission(
        sessionKey,
        toolName,
        blacklist.updatedInput,
        permissionPrompt,
        this.permissionContexts.get(sessionKey),
        summary,
        reason || '外部 MCP/app 工具不受 Codex 本地 command sandbox 的完整约束',
        grantScope,
      );
    }

    // auto 模式下检查危险命令，危险命令自动拒绝
    if (mode === 'auto') {
      if (toolName === 'PermissionGrant' || hasFileChangeExpansion || hasPermissionExpansion) return 'deny';
      const dangerous = checkDangerousCommand(toolName, toolInput);
      if (dangerous.isDangerous) return 'deny';
      return 'allow';
    }

    if (mode === 'bypass') {
      if (toolName === 'PermissionGrant' || hasFileChangeExpansion || hasPermissionExpansion) {
        if (!this.permissionGateway || !permissionPrompt) return 'deny';
        return this.permissionGateway.requestPermission(
          sessionKey,
          toolName,
          toolInput,
          permissionPrompt,
          this.permissionContexts.get(sessionKey),
          summary,
          reason || 'Codex 请求扩大当前命令或 turn 的沙箱权限',
          grantScope,
        );
      }
      const dangerous = await requestDangerousCommandPermission(
        this.permissionGateway,
        sessionKey,
        toolName,
        toolInput,
        permissionPrompt,
        this.permissionContexts.get(sessionKey),
        grantScope,
      );
      if (dangerous.matched) return dangerous.decision;
      return 'allow';
    }
    if (!this.permissionGateway || !permissionPrompt) return 'deny';
    return this.permissionGateway.requestPermission(
      sessionKey,
      toolName,
      toolInput,
      permissionPrompt,
      this.permissionContexts.get(sessionKey),
      summary,
      reason,
      grantScope,
    );
  }

  private toAppServerApprovalResponse(
    method: string,
    decision: 'allow' | 'always' | 'deny',
    toolInput?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: decision === 'deny' ? 'denied' : 'approved' };
    }
    if (method === 'item/commandExecution/requestApproval') {
      return { decision: decision === 'deny' ? 'decline' : 'accept' };
    }
    if (method === 'item/fileChange/requestApproval') {
      return { decision: decision === 'deny' ? 'decline' : 'accept' };
    }
    if (method === 'item/permissions/requestApproval') {
      if (decision === 'deny') throw new Error('Permission request denied');
      const permissions = toolInput?.permissions;
      return {
        permissions: permissions && typeof permissions === 'object' ? permissions : {},
        scope: 'turn',
        strictAutoReview: true,
      };
    }
    throw new Error('Unsupported Codex app-server request: ' + method);
  }

  async rollbackSessionTurns(agentSessionId: string, _projectPath: string, numTurns: number): Promise<boolean> {
    if (numTurns < 1) return true;
    const response = await this.getAppServerClient().threadRollback(agentSessionId, numTurns);
    return !!response.thread;
  }

  async rewindFiles(agentSessionId: string, projectPath: string, userMessageId: string): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }> {
    const messages = await this.getSessionMessages(agentSessionId, projectPath);
    const targetIndex = messages.findIndex(message => message.uuid === userMessageId);
    if (targetIndex < 0) return { canRewind: false, error: 'target turn not found' };

    const changedFiles = new Set<string>();
    for (let i = targetIndex; i < messages.length; i++) {
      const message = messages[i];
      const content = Array.isArray((message.message as any)?.content) ? (message.message as any).content : [];
      for (const part of content) {
        if (part?.type === 'file_change' && typeof part.path === 'string') changedFiles.add(part.path);
      }
    }

    if (changedFiles.size === 0) {
      return { canRewind: false, error: 'no file changes recorded for target turn' };
    }

    const snapshotFiles = [...changedFiles];
    for (const filePath of snapshotFiles) {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
      const content = this.readGitHeadFile(projectPath, filePath);
      if (content === null) {
        fs.rmSync(absolutePath, { force: true });
      } else {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
      }
    }

    return { canRewind: true, filesChanged: snapshotFiles };
  }

  private readGitHeadFile(projectPath: string, filePath: string): Buffer | null {
    try {
      return execFileSync('git', ['show', `HEAD:${filePath.replace(/\\/g, '/')}`], { cwd: projectPath, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  }

  private mapThreadToSessionMessages(response: CodexThreadResponse, fallbackThreadId: string): Array<{
    type: 'user' | 'assistant' | 'system';
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: null;
  }> {
    const thread = response.thread;
    const threadId = thread?.id || fallbackThreadId;
    const messages: Array<{
      type: 'user' | 'assistant' | 'system';
      uuid: string;
      session_id: string;
      message: unknown;
      parent_tool_use_id: null;
    }> = [];

    for (const turn of thread?.turns ?? []) {
      for (const item of this.getTurnItems(turn)) {
        if (item.type === 'userMessage') {
          messages.push({
            type: 'user',
            uuid: item.id || turn.id || (threadId + '-user-' + messages.length),
            session_id: threadId,
            message: { role: 'user', content: this.mapUserInputToContent(item.content) },
            parent_tool_use_id: null,
          });
        } else if (item.type === 'agentMessage') {
          messages.push({
            type: 'assistant',
            uuid: item.id || turn.id || (threadId + '-assistant-' + messages.length),
            session_id: threadId,
            message: { role: 'assistant', content: item.text || '' },
            parent_tool_use_id: null,
          });
        } else if (item.type === 'file_change') {
          messages.push({
            type: 'system',
            uuid: item.id || turn.id || (threadId + '-file-' + messages.length),
            session_id: threadId,
            message: { role: 'system', content: this.mapFileChangeToContent(item) },
            parent_tool_use_id: null,
          });
        }
      }
    }

    return messages;
  }

  private getTurnItems(turn: any): CodexTurnItem[] {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const input = Array.isArray(turn?.input) ? turn.input : [];
    const output = Array.isArray(turn?.output) ? turn.output : [];
    return [...items, ...input, ...output] as CodexTurnItem[];
  }

  private mapUserInputToContent(content: unknown): Array<{ type: string; text?: string; path?: string; url?: string }> {
    if (!Array.isArray(content)) return [];
    return content.map((part: any) => {
      if (part?.type === 'text') return { type: 'text', text: part.text || '' };
      if (part?.type === 'localImage') return { type: 'image', path: part.path };
      if (part?.type === 'image') return { type: 'image', url: part.url };
      return { type: 'text', text: part?.text || part?.name || '' };
    });
  }

  private mapFileChangeToContent(item: CodexTurnItem): Array<{ type: string; path: string; kind?: string }> {
    const changes = this.normalizeFileChanges((item as any).changes);
    return changes
      .filter((change: any) => typeof change?.path === 'string')
      .map((change: any) => {
        const kind = this.normalizeFileChangeKind(change.kind ?? change.type);
        return {
          type: 'file_change',
          path: change.path,
          ...(kind ? { kind } : {}),
        };
      });
  }

  private normalizeFileChanges(changes: unknown): any[] {
    if (Array.isArray(changes)) return changes;
    if (!changes || typeof changes !== 'object') return [];
    return Object.entries(changes as Record<string, unknown>).map(([filePath, change]) => ({
      ...(change && typeof change === 'object' ? change : {}),
      path: filePath,
    }));
  }

  private describeFileChange(change: any): string {
    const kind = this.normalizeFileChangeKind(change?.kind ?? change?.type);
    const filePath = typeof change?.path === 'string' ? change.path : '';
    return [kind || 'change', filePath].filter(Boolean).join(' ');
  }

  private normalizeFileChangeKind(kind: unknown): string | undefined {
    if (typeof kind === 'string') return kind;
    if (!kind || typeof kind !== 'object') return undefined;
    const data = kind as Record<string, unknown>;
    for (const key of ['type', 'kind', 'action', 'operation', 'op']) {
      if (typeof data[key] === 'string') return data[key];
    }
    return undefined;
  }

  private isThreadNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /thread\/compact\/start failed: thread not found:/i.test(message)
      || /thread not found:/i.test(message);
  }

  setCompactStartCallback(callback: (sessionId: string) => void): void {
    this.onCompactStart = callback;
  }

  // ── Event stream transformation ──

  private buildAppServerInput(
    prompt: string,
    images: Array<{ data: string; mimeType?: string }> | undefined,
    tempFiles: string[]
  ): any[] {
    const input: any[] = [{ type: 'text', text: prompt, text_elements: [] }];
    if (!images?.length) return input;

    const tmpDir = os.tmpdir();
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const ext = MIME_EXT[img.mimeType || ''] || '.jpg';
      const tmpPath = path.join(tmpDir, `evolclaw-img-${Date.now()}-${i}${ext}`);
      fs.writeFileSync(tmpPath, Buffer.from(img.data, 'base64'));
      tempFiles.push(tmpPath);
      input.push({ type: 'localImage', path: tmpPath });
    }
    logger.info(`[CodexRunner] Attached ${images.length} image(s) as localImage`);
    return input;
  }

  private cleanupTempFiles(tempFiles?: string[]): void {
    if (!tempFiles?.length) return;
    for (const tempFile of tempFiles) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  private extractTurnId(notification: CodexServerNotification): string | undefined {
    const params: any = notification.params || {};
    return typeof params.turnId === 'string' ? params.turnId :
      typeof params.turn_id === 'string' ? params.turn_id :
      typeof params.turn?.id === 'string' ? params.turn.id : undefined;
  }

  private isAppServerTurnNotification(notification: CodexServerNotification, state: AppServerStreamState): boolean {
    const params: any = notification.params || {};
    const notifThreadId = params.threadId ?? params.thread_id;
    if (notifThreadId !== undefined && notifThreadId !== state.threadId) return false;
    const turnId = this.extractTurnId(notification);
    if (!state.turnId) {
      return notification.method === 'turn/started' || !turnId;
    }
    return !state.turnId || !turnId || turnId === state.turnId;
  }

  private async *transformAppServerStream(
    notifications: AsyncIterable<CodexServerNotification>,
    sessionId: string,
    state: AppServerStreamState,
    unsubscribe: () => void,
    tempFiles?: string[]
  ): AsyncGenerator<AgentEvent> {
    try {
      yield { type: 'session_id', sessionId: state.threadId };
      for await (const notification of notifications) {
        if (!this.activeAbortControllers.has(sessionId)) break;
        yield* this.mapAppServerNotification(notification, sessionId, state);
      }
    } finally {
      unsubscribe();
      this.activeAbortControllers.delete(sessionId);
      this.activeTurns.delete(sessionId);
      this.cleanupTempFiles(tempFiles);
    }
  }

  private *mapAppServerNotification(
    notification: CodexServerNotification,
    sessionId: string,
    state: AppServerStreamState
  ): Iterable<AgentEvent> {
    const params: any = notification.params || {};
    switch (notification.method) {
      case 'turn/started': {
        const turnId = this.extractTurnId(notification);
        if (turnId) {
          state.turnId = turnId;
          this.activeTurns.set(sessionId, { threadId: state.threadId, turnId });
        }
        yield { type: 'state_changed', state: 'running' };
        break;
      }

      case 'item/started': {
        yield* this.mapAppServerItemStarted(params.item, state);
        break;
      }

      case 'item/agentMessage/delta': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        if (itemId) state.streamedAgentMessageIds.add(itemId);
        if (itemId && typeof params.delta === 'string' && params.delta) {
          state.agentMessageDeltaText.set(
            itemId,
            (state.agentMessageDeltaText.get(itemId) || '') + params.delta
          );
        }
        break;
      }

      case 'item/completed': {
        const item = params.item;
        if (item?.id) state.completedItemIds.add(item.id);
        yield* this.mapAppServerItemCompleted(item, state);
        break;
      }

      case 'item/fileChange/patchUpdated': {
        yield* this.mapAppServerFileChangePatchUpdated(params, state);
        break;
      }

      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        const completed = plan.filter((step: any) => step?.status === 'completed').length;
        const summary = plan.length ? `计划进度：${completed}/${plan.length}` : (params.explanation || '计划已更新');
        yield { type: 'task_progress', summary };
        break;
      }

      case 'thread/tokenUsage/updated': {
        state.tokenUsage = params.tokenUsage;
        break;
      }

      case 'thread/compacted': {
        logger.info(`[CodexRunner] Compact completed for thread: ${params.threadId || state.threadId}`);
        yield { type: 'compact', preTokens: 0 };
        break;
      }

      case 'turn/completed': {
        const turn = params.turn || {};
        const turnId = turn.id || params.turnId;
        if (turnId && state.completedTurnIds.has(turnId)) break;
        if (turnId) state.completedTurnIds.add(turnId);
        this.activeTurns.delete(sessionId);
        if (turn.status === 'failed' && turn.error?.message) {
          if (isRetryableError(new Error(turn.error.message))) {
            throw new Error(turn.error.message);
          }
          yield { type: 'error', error: turn.error.message, errorType: 'unknown' };
        }
        yield this.mapAppServerTurnComplete(turn, state);
        break;
      }

      case 'error': {
        if (!params.message) {
          // SSE idle timeout reconnect — not a real task error, suppress
          logger.debug(`[CodexRunner] app-server SSE reconnect (no message)`);
          break;
        }
        if (isRetryableError(new Error(params.message))) {
          throw new Error(params.message);
        }
        yield { type: 'error', error: params.message, errorType: 'unknown' };
        break;
      }
    }
  }

  private *mapAppServerItemStarted(item: any, state?: AppServerStreamState): Iterable<AgentEvent> {
    if (!item) return;
    switch (item.type) {
      case 'commandExecution':
        yield { type: 'tool_use', name: 'Shell', input: { command: item.command, cwd: item.cwd }, callId: item.id };
        break;
      case 'mcpToolCall':
        yield { type: 'tool_use', name: `MCP:${item.server}/${item.tool}`, input: item.arguments, callId: item.id };
        break;
      case 'dynamicToolCall':
        yield { type: 'tool_use', name: item.namespace ? `${item.namespace}:${item.tool}` : item.tool, input: item.arguments, callId: item.id };
        break;
      case 'fileChange': {
        const editEvent = this.buildCodexEditEvent(item.id, item.changes);
        if (editEvent) {
          if (item.id) state?.emittedEditCallIds.add(item.id);
          yield editEvent;
        } else {
          const desc = this.normalizeFileChanges(item.changes).map((change: any) => this.describeFileChange(change)).join(', ');
          if (desc) {
            yield { type: 'tool_use', name: 'FileChange', input: { description: desc }, callId: item.id };
          }
        }
        break;
      }
      case 'webSearch':
        yield { type: 'tool_use', name: 'WebSearch', input: { query: item.query }, callId: item.id };
        break;
      case 'plan':
        yield { type: 'task_progress', summary: item.text || '计划已更新' };
        break;
    }
  }

  private *mapAppServerItemCompleted(item: any, state: AppServerStreamState): Iterable<AgentEvent> {
    if (!item) return;
    switch (item.type) {
      case 'agentMessage':
        {
          const buffered = item.id ? state.agentMessageDeltaText.get(item.id) : undefined;
          const text = typeof item.text === 'string' && item.text ? item.text : buffered;
          if (text) yield { type: 'text', text };
          if (item.id) state.agentMessageDeltaText.delete(item.id);
        }
        break;
      case 'commandExecution':
        yield {
          type: 'tool_result',
          name: 'Shell',
          result: item.aggregatedOutput ?? '',
          isError: item.exitCode !== null && item.exitCode !== undefined ? item.exitCode !== 0 : item.status === 'failed',
          callId: item.id,
        };
        break;
      case 'mcpToolCall':
        yield {
          type: 'tool_result',
          name: `MCP:${item.server}/${item.tool}`,
          result: item.result,
          isError: item.status === 'failed',
          error: item.error?.message,
          callId: item.id,
        };
        break;
      case 'dynamicToolCall':
        yield {
          type: 'tool_result',
          name: item.namespace ? `${item.namespace}:${item.tool}` : item.tool,
          result: item.contentItems,
          isError: item.success === false || item.status === 'failed',
          callId: item.id,
        };
        break;
      case 'fileChange':
        if (this.fileChangesHaveProtocolDiff(item.changes)) {
          if (item.id && !state.emittedEditCallIds.has(item.id)) {
            const editEvent = this.buildCodexEditEvent(item.id, item.changes);
            if (editEvent) {
              state.emittedEditCallIds.add(item.id);
              yield editEvent;
            }
          }
          yield { type: 'tool_result', name: 'Edit', result: item.changes, isError: item.status === 'failed', callId: item.id };
        } else {
          const desc = this.normalizeFileChanges(item.changes).map((change: any) => this.describeFileChange(change)).join(', ');
          yield { type: 'tool_use', name: 'FileChange', input: { description: desc }, callId: item.id };
          yield { type: 'tool_result', name: 'FileChange', result: item.changes, isError: item.status === 'failed', callId: item.id };
        }
        break;
    }
  }

  private *mapAppServerFileChangePatchUpdated(params: any, state: AppServerStreamState): Iterable<AgentEvent> {
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    if (!itemId || state.emittedEditCallIds.has(itemId)) return;
    const editEvent = this.buildCodexEditEvent(itemId, params.changes);
    if (!editEvent) return;
    state.emittedEditCallIds.add(itemId);
    yield editEvent;
  }

  private buildCodexEditEvent(callId: string | undefined, changes: unknown): AgentEvent | null {
    const editInput = this.buildCodexEditInput(changes);
    if (!editInput) return null;
    return { type: 'tool_use', name: 'Edit', input: editInput, callId };
  }

  private buildCodexEditInput(changes: unknown): Record<string, unknown> | null {
    const normalized = this.normalizeFileChanges(changes)
      .map((change: any) => this.normalizeCodexProtocolDiffChange(change))
      .filter((change): change is { path: string; diff: string; kind?: string } => !!change);
    if (normalized.length === 0) return null;
    const first = normalized[0];
    return {
      file_path: first.path,
      unified_diff: normalized.map(change => this.formatCodexUnifiedDiff(change)).join('\n'),
      codex_file_changes: normalized,
    };
  }

  private normalizeCodexProtocolDiffChange(change: any): { path: string; diff: string; kind?: string } | null {
    const filePath = typeof change?.path === 'string' ? change.path : '';
    const diff = typeof change?.diff === 'string' ? change.diff
      : typeof change?.unified_diff === 'string' ? change.unified_diff
      : typeof change?.unifiedDiff === 'string' ? change.unifiedDiff
      : '';
    if (!filePath || !diff) return null;
    return {
      path: filePath,
      diff,
      kind: this.normalizeFileChangeKind(change.kind ?? change.type),
    };
  }

  private fileChangesHaveProtocolDiff(changes: unknown): boolean {
    return this.buildCodexEditInput(changes) !== null;
  }

  private formatCodexUnifiedDiff(change: { path: string; diff: string; kind?: string }): string {
    const pathLabel = change.path.replace(/\\/g, '/');
    const diffPath = pathLabel.replace(/^\/+/, '');
    const header = change.diff.startsWith('diff ')
      || change.diff.startsWith('--- ')
      || change.diff.startsWith('+++ ')
      ? ''
      : `--- a/${diffPath}\n+++ b/${diffPath}\n`;
    return `${header}${change.diff.trimEnd()}`;
  }

  private pickNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
  }

  private mapCodexTokenUsage(raw: any): NormalizedTokenUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const usage = {
      input_tokens: this.pickNumber(raw.inputTokens, raw.input_tokens),
      output_tokens: this.pickNumber(raw.outputTokens, raw.output_tokens),
      cache_read_input_tokens: this.pickNumber(raw.cachedInputTokens, raw.cache_read_input_tokens, raw.cached_input_tokens),
      cache_creation_input_tokens: this.pickNumber(raw.cacheCreationInputTokens, raw.cache_creation_input_tokens, raw.cache_creation_tokens),
    };
    return Object.values(usage).some(value => value !== undefined) ? usage : undefined;
  }

  private mapCodexContextUsage(raw: any): NormalizedContextUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const totalTokens = this.pickNumber(raw.totalTokens, raw.total_tokens, raw.total);
    const maxTokens = this.pickNumber(raw.maxTokens, raw.max_tokens, raw.max);
    const model = typeof raw.model === 'string' ? raw.model : undefined;
    if (totalTokens === undefined || maxTokens === undefined || !model) return undefined;
    const percentage = this.pickNumber(raw.percentage) ?? Math.round((totalTokens / maxTokens) * 100);
    const effort = typeof raw.effort === 'string' ? raw.effort : undefined;
    return { totalTokens, maxTokens, percentage, model, effort };
  }

  private mapAppServerTurnComplete(turn: any, state: AppServerStreamState): AgentEvent {
    const status = turn.status || 'completed';
    const tokenUsage = this.mapCodexTokenUsage(state.tokenUsage?.last ?? turn.tokenUsage ?? turn.usage);
    const contextUsage = this.mapCodexContextUsage(turn.contextUsage ?? state.tokenUsage?.contextUsage ?? state.tokenUsage?.context);
    const terminalReason = status === 'completed'
      ? undefined
      : status === 'interrupted'
        ? 'aborted_streaming'
        : status;
    return {
      type: 'complete',
      subtype: status === 'completed' ? 'success' : status,
      isError: status === 'failed',
      errors: turn.error?.message ? [turn.error.message] : undefined,
      terminalReason,
      durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
      ttftMs: this.pickNumber(turn.ttftMs, turn.ttft_ms),
      costUsd: this.pickNumber(turn.costUsd, turn.totalCostUsd, turn.total_cost_usd),
      sessionTitle: typeof turn.sessionTitle === 'string' ? turn.sessionTitle : typeof turn.session_title === 'string' ? turn.session_title : undefined,
      numTurns: this.pickNumber(turn.numTurns, turn.num_turns),
      tokenUsage,
      contextUsage,
    } as AgentEvent;
  }

  private buildEvolclawShellEnvironmentConfig(sessionId: string): Record<string, any> {
    return {
      shell_environment_policy: {
        set: {
          EVOLCLAW_SESSION_ID: sessionId,
          EVOLCLAW_HOME: resolveRoot(),
        },
      },
    };
  }

  async dispose(): Promise<void> {
    // Abort all active streams
    for (const [key, controller] of this.activeAbortControllers) {
      controller.abort('dispose');
    }
    this.activeAbortControllers.clear();
    this.activeStreams.clear();
    this.activeSessions.clear();
    this.activeTurns.clear();
    this.threadProjectPaths.clear();
    this.threadExternalToolFingerprints.clear();
    this.trackedApprovalItems.clear();
    this.pendingInterrupts.clear();
    this.permissionContexts.clear();
    this.chatModes.clear();
    await this.appServerClient?.close();
    this.appServerClient = null;
  }
}

// ── Plugin ──

export class CodexAgentPlugin implements AgentPlugin {
  readonly name = 'codex';

  isEnabled(agent: import('../core/evolagent.js').EvolAgent): boolean {
    if (!agent.config.baseagents?.codex) return false;
    if (!isCodexAppServerAvailable()) return false;
    try {
      const override = agent.config.baseagents.codex as any;
      const syntheticConfig = { agents: { codex: override } } as Config;
      const resolved = resolveOpenaiConfig(syntheticConfig, override);
      return !!resolved.apiKey;
    } catch {
      return false;
    }
  }

  createAgent(agent: import('../core/evolagent.js').EvolAgent, callbacks: AgentCallbacks): AgentInstance | null {
    const availability = getCodexAppServerAvailability();
    if (!availability.available) {
      throw new Error(availability.reason || 'Missing codex CLI with app-server');
    }
    const override = agent.config.baseagents?.codex as any;
    const merged: Config = {
      agents: {
        codex: {
          ...(override || {}),
          evolclawAgentAid: agent.config.aid,
          evolclawAgentConfig: agent.config,
        },
      },
    } as Config;
    return { evolagentName: agent.name, baseagent: 'codex', agent: new CodexRunner(merged, callbacks) };
  }
}
