import { createHash } from 'crypto';
import type { Config, EffectiveAgentConfig } from '../../types.js';
import {
  resolveAnthropicConfig,
  resolveOpenaiConfig,
  type AnthropicResolved,
  type OpenaiResolved,
} from '../../agents/baseagent.js';

export interface TextInferenceRequest {
  model: string;
  effort?: string;
  system: string;
  input: string;
  signal?: AbortSignal;
}

export interface TextInferenceProvider {
  readonly baseagent: 'claude' | 'codex';
  listModels?(signal?: AbortSignal): Promise<string[]>;
  completeText(request: TextInferenceRequest): Promise<string>;
}

const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
const MODEL_LIST_MAX_PAGES = 20;
const anthropicModelListCache = new Map<string, { models: string[]; fetchedAt: number }>();

function apiEndpoint(baseUrl: string | undefined, defaultBaseUrl: string, resource: string): string {
  const base = (baseUrl || defaultBaseUrl).replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/${resource}` : `${base}/v1/${resource}`;
}

async function parseError(response: Response): Promise<Error> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {}
  let detail = raw;
  try {
    const body = JSON.parse(raw) as Record<string, any>;
    detail = body?.error?.message || body?.message || body?.detail || raw;
  } catch {}
  const suffix = detail ? `: ${String(detail).slice(0, 500)}` : '';
  return new Error(`Text inference request failed with HTTP ${response.status}${suffix}`);
}

export class AnthropicTextInferenceProvider implements TextInferenceProvider {
  readonly baseagent = 'claude' as const;

  constructor(private config: AnthropicResolved) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const cacheKey = this.modelListCacheKey();
    const cached = anthropicModelListCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MODEL_LIST_TTL_MS) return [...cached.models];

    const models: string[] = [];
    const seen = new Set<string>();
    let afterId: string | undefined;
    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
      const endpoint = new URL(apiEndpoint(this.config.baseUrl, 'https://api.anthropic.com', 'models'));
      endpoint.searchParams.set('limit', '100');
      if (afterId) endpoint.searchParams.set('after_id', afterId);
      const response = await fetch(endpoint, {
        method: 'GET',
        signal,
        headers: this.headers(),
      });
      if (!response.ok) throw await parseError(response);
      const body = await response.json() as Record<string, any>;
      const entries = Array.isArray(body.data)
        ? body.data
        : (Array.isArray(body.models) ? body.models : []);
      for (const entry of entries) {
        const id = typeof entry === 'string'
          ? entry
          : entry?.id || entry?.name || entry?.model;
        if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue;
        seen.add(id);
        models.push(id);
      }
      if (body.has_more !== true) break;
      const next = typeof body.last_id === 'string' && body.last_id ? body.last_id : undefined;
      if (!next || next === afterId) throw new Error('Claude model list pagination returned no next cursor');
      afterId = next;
    }
    if (models.length === 0) throw new Error('Claude model list API returned no models');
    anthropicModelListCache.set(cacheKey, { models, fetchedAt: Date.now() });
    return [...models];
  }

  async completeText(request: TextInferenceRequest): Promise<string> {
    const response = await fetch(apiEndpoint(this.config.baseUrl, 'https://api.anthropic.com', 'messages'), {
      method: 'POST',
      signal: request.signal,
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        max_tokens: 256,
        system: request.system,
        messages: [{ role: 'user', content: request.input }],
      }),
    });
    if (!response.ok) throw await parseError(response);
    const body = await response.json() as Record<string, any>;
    const text = Array.isArray(body.content)
      ? body.content
          .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
          .map((item: any) => item.text)
          .join('')
      : '';
    if (!text) throw new Error('Text inference response contained no text');
    return text;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': this.config.apiKey,
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private modelListCacheKey(): string {
    const endpoint = apiEndpoint(this.config.baseUrl, 'https://api.anthropic.com', 'models');
    const credential = createHash('sha256').update(this.config.apiKey).digest('hex');
    return `${endpoint}\0${credential}`;
  }
}

export function _resetTextInferenceModelCacheForTests(): void {
  anthropicModelListCache.clear();
}

export class OpenAITextInferenceProvider implements TextInferenceProvider {
  readonly baseagent = 'codex' as const;

  constructor(private config: OpenaiResolved) {}

  async completeText(request: TextInferenceRequest): Promise<string> {
    const response = await fetch(apiEndpoint(this.config.baseUrl, 'https://api.openai.com', 'responses'), {
      method: 'POST',
      signal: request.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        instructions: request.system,
        input: request.input,
        store: false,
        tool_choice: 'none',
        max_output_tokens: 256,
        ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
      }),
    });
    if (!response.ok) throw await parseError(response);
    const body = await response.json() as Record<string, any>;
    const direct = typeof body.output_text === 'string' ? body.output_text : '';
    const text = direct || (Array.isArray(body.output)
      ? body.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
          .filter((item: any) => item?.type === 'output_text' && typeof item.text === 'string')
          .map((item: any) => item.text)
          .join('')
      : '');
    if (!text) throw new Error('Text inference response contained no text');
    return text;
  }
}

export function createTextInferenceProvider(
  baseagent: string,
  config: EffectiveAgentConfig,
): TextInferenceProvider | undefined {
  if (baseagent === 'claude') {
    const override = config.baseagents?.claude;
    if (!override) return undefined;
    const synthetic = { agents: { claude: override } } as Config;
    return new AnthropicTextInferenceProvider(resolveAnthropicConfig(synthetic, override));
  }
  if (baseagent === 'codex') {
    const override = config.baseagents?.codex;
    if (!override) return undefined;
    const synthetic = { agents: { codex: override } } as Config;
    return new OpenAITextInferenceProvider(resolveOpenaiConfig(synthetic, override));
  }
  return undefined;
}
