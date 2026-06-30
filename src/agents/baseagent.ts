/**
 * Baseagent identity + credential resolution.
 *
 * 两部分：
 *  1. normalizeBaseagent —— 把用户输入的各种别名（cc / claude-code / gemini cli …）
 *     归一到 canonical 标识 + 展示名。
 *  2. resolve*Config —— 各后端的凭证解析。输入是 Config 形态
 *     （`config.agents.<baseagent>` + override）。启动期由 index.ts 从
 *     primaryAgent.config.baseagents 构造一个 syntheticConfig 喂入；各 plugin 的
 *     createAgent 也各自构造 syntheticConfig。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { commandExists } from '../utils/cross-platform.js';
import type { AgentConfig, Config, EffectiveAgentConfig } from '../types.js';

// ── baseagent 别名归一 ─────────────────────────────────────────────────

export type CanonicalBaseagent = 'claude' | 'codex' | 'gemini' | 'hermes' | 'unknown';

export interface NormalizedBaseagent {
  canonical: CanonicalBaseagent;
  displayName: string;
}

const BASEAGENT_ALIASES: Record<string, NormalizedBaseagent> = {
  claude: { canonical: 'claude', displayName: 'Claude Code' },
  cc: { canonical: 'claude', displayName: 'Claude Code' },
  'claude-code': { canonical: 'claude', displayName: 'Claude Code' },
  'claude code': { canonical: 'claude', displayName: 'Claude Code' },
  claudecode: { canonical: 'claude', displayName: 'Claude Code' },

  codex: { canonical: 'codex', displayName: 'Codex' },
  'codex-cli': { canonical: 'codex', displayName: 'Codex' },
  'codex cli': { canonical: 'codex', displayName: 'Codex' },

  gemini: { canonical: 'gemini', displayName: 'Gemini CLI' },
  'gemini-cli': { canonical: 'gemini', displayName: 'Gemini CLI' },
  'gemini cli': { canonical: 'gemini', displayName: 'Gemini CLI' },
  geminicli: { canonical: 'gemini', displayName: 'Gemini CLI' },

  hermes: { canonical: 'hermes', displayName: 'Hermes' },
};

export function normalizeBaseagent(input: string | undefined | null): NormalizedBaseagent {
  const key = String(input || '').trim().toLowerCase().replace(/_/g, '-');
  return BASEAGENT_ALIASES[key] || { canonical: 'unknown', displayName: input ? String(input) : 'Unknown' };
}

// ── 凭证解析 ───────────────────────────────────────────────────────────

// ── Anthropic (Claude) ─────────────────────────────────────────────────

export interface AnthropicResolved {
  apiKey: string;
  baseUrl?: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  pathToClaudeCodeExecutable?: string;
}

function loadClaudeSettings(): { env?: Record<string, string>; model?: string; effortLevel?: 'low' | 'medium' | 'high' } {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch {}
  return {};
}

export function resolveAnthropicConfig(
  config: Config,
  override?: { apiKey?: string; baseUrl?: string; model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; pathToClaudeCodeExecutable?: string }
): AnthropicResolved {
  const settings = loadClaudeSettings();
  const isPlaceholder = (v?: string) => !v || v.includes('your-') || v.includes('placeholder');

  const overrideApiKey = isPlaceholder(override?.apiKey) ? undefined : override?.apiKey;
  const globalApiKey = isPlaceholder(config.agents?.claude?.apiKey) ? undefined : config.agents?.claude?.apiKey;
  const apiKey = overrideApiKey
    || globalApiKey
    || process.env.ANTHROPIC_AUTH_TOKEN
    || settings.env?.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey) {
    throw new Error(
      'No API key found. Set one of: baseagents.claude.apiKey (per-agent or defaults), env ANTHROPIC_AUTH_TOKEN, or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN'
    );
  }

  const isPlaceholderUrl = (v?: string) => !v || v.includes('api.anthropic.com');
  const overrideBaseUrl = isPlaceholderUrl(override?.baseUrl) ? undefined : override?.baseUrl;
  const globalBaseUrl = isPlaceholderUrl(config.agents?.claude?.baseUrl) ? undefined : config.agents?.claude?.baseUrl;
  const baseUrl = overrideBaseUrl
    || globalBaseUrl
    || process.env.ANTHROPIC_BASE_URL
    || settings.env?.ANTHROPIC_BASE_URL;

  const model = override?.model
    || config.agents?.claude?.model
    || settings.model
    || 'sonnet';

  const effort = override?.effort
    || config.agents?.claude?.effort
    || settings.effortLevel
    || undefined;

  const pickExec = (v?: string) => (!v || v.includes('your-') || v.includes('placeholder')) ? undefined : v;
  const pathToClaudeCodeExecutable = pickExec(override?.pathToClaudeCodeExecutable)
    || pickExec(config.agents?.claude?.pathToClaudeCodeExecutable);

  return { apiKey, baseUrl, model, effort, pathToClaudeCodeExecutable };
}

// ── OpenAI (Codex) ─────────────────────────────────────────────────────

export interface OpenaiResolved {
  apiKey: string;
  baseUrl?: string;
  model: string;
  effort?: string;
  enableRequestUserInput?: boolean;
  approvalsReviewer?: string;
  evolclawAgentAid?: string;
  evolclawAgentConfig?: AgentConfig | EffectiveAgentConfig;
}

function loadCodexSettings(): { apiKey?: string; baseUrl?: string; model?: string } {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    let apiKey: string | undefined;
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      apiKey = auth.OPENAI_API_KEY;
    }

    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    let model: string | undefined;
    let baseUrl: string | undefined;
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
      if (modelMatch) model = modelMatch[1];

      const providerMatch = content.match(/^model_provider\s*=\s*"([^"]+)"/m);
      if (providerMatch) {
        const provider = providerMatch[1];
        const baseUrlMatch = content.match(new RegExp(`\\[model_providers\\.${provider}\\][\\s\\S]*?base_url\\s*=\\s*"([^"]+)"`, 'm'));
        if (baseUrlMatch) baseUrl = baseUrlMatch[1];
      }
    }

    return { apiKey, baseUrl, model };
  } catch {}
  return {};
}

export function resolveOpenaiConfig(
  config: Config,
  override?: { apiKey?: string; baseUrl?: string; model?: string; effort?: string; reasoning?: string; enableRequestUserInput?: boolean; approvalsReviewer?: string }
): OpenaiResolved {
  const codexSettings = loadCodexSettings();
  const isPlaceholder = (v?: string) => !v || v.includes('your-') || v.includes('placeholder');

  const overrideApiKey = isPlaceholder(override?.apiKey) ? undefined : override?.apiKey;
  const globalApiKey = isPlaceholder(config.agents?.codex?.apiKey) ? undefined : config.agents?.codex?.apiKey;
  const apiKey = overrideApiKey
    || globalApiKey
    || process.env.OPENAI_API_KEY
    || codexSettings.apiKey;

  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set one of: baseagents.codex.apiKey (per-agent or defaults), env OPENAI_API_KEY, or ~/.codex/auth.json'
    );
  }

  const isPlaceholderUrl = (v?: string) => !v || v.includes('api.openai.com');
  const overrideBaseUrl = isPlaceholderUrl(override?.baseUrl) ? undefined : override?.baseUrl;
  const globalBaseUrl = isPlaceholderUrl(config.agents?.codex?.baseUrl) ? undefined : config.agents?.codex?.baseUrl;
  const baseUrl = overrideBaseUrl
    || globalBaseUrl
    || process.env.OPENAI_BASE_URL
    || codexSettings.baseUrl
    || undefined;

  const model = override?.model
    || config.agents?.codex?.model
    || codexSettings.model
    || 'gpt-5.2-codex';

  const effort = override?.effort
    || override?.reasoning
    || config.agents?.codex?.effort
    || (config.agents?.codex as any)?.reasoning
    || undefined;

  const enableRequestUserInput = override?.enableRequestUserInput
    ?? config.agents?.codex?.enableRequestUserInput
    ?? true;

  const approvalsReviewer = override?.approvalsReviewer
    ?? config.agents?.codex?.approvalsReviewer
    ?? undefined;

  return { apiKey, baseUrl, model, effort, enableRequestUserInput, approvalsReviewer };
}

// ── Google (Gemini) ────────────────────────────────────────────────────

export interface GoogleResolved {
  cliPath: string;
  model: string;
  apiKey?: string;
  mode: 'cli' | 'sdk';
  useVertex?: boolean;
  project?: string;
  location?: string;
}

export function resolveGoogleConfig(
  config: Config,
  override?: { cliPath?: string; model?: string; apiKey?: string; mode?: 'cli' | 'sdk'; useVertex?: boolean; project?: string; location?: string }
): GoogleResolved {
  const googleCfg = config.agents?.gemini;
  const isPlaceholder = (v?: string) => !v || v.includes('your-') || v.includes('placeholder');

  let cliPath = override?.cliPath || googleCfg?.cliPath || '';
  if (!cliPath) {
    cliPath = commandExists('gemini') ? 'gemini' : '';
  }

  const model = override?.model || googleCfg?.model || 'gemini-2.5-flash';

  const overrideApiKey = isPlaceholder(override?.apiKey) ? undefined : override?.apiKey;
  const globalApiKey = isPlaceholder(googleCfg?.apiKey) ? undefined : googleCfg?.apiKey;
  const apiKey = overrideApiKey
    || globalApiKey
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || undefined;

  const mode = override?.mode || googleCfg?.mode || 'cli';
  const useVertex = override?.useVertex ?? googleCfg?.useVertex ?? false;
  const project = override?.project || googleCfg?.project || process.env.GOOGLE_CLOUD_PROJECT || undefined;
  const location = override?.location || googleCfg?.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

  return { cliPath, model, apiKey, mode, useVertex, project, location };
}
