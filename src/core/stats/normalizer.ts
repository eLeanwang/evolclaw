/**
 * normalizer.ts — 各模型 raw usage 字段 → 归一化 UsageEvent，同时推断 billing_fn。
 * 按实际有什么字段智能探测，不假设接入方式。
 */

export interface UsageEvent {
  ts: number;
  agent_aid: string;
  peer_key: string;
  peer_type?: string;
  session_id?: string;
  model: string;
  billing_fn: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  image_tokens?: number;
  total_context_tokens?: number;
  turns: number;
  duration_ms?: number;
  context_window_pct?: number;
}

export interface RawUsage {
  // Anthropic / Claude
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // OpenAI 兼容
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  // DeepSeek
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  // Gemini 原生
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  // Qwen-VL / 视觉模型
  image_tokens?: number;
  [key: string]: unknown;
}

export function normalizeUsage(
  raw: RawUsage,
  meta: {
    ts: number;
    agent_aid: string;
    peer_key: string;
    peer_type?: string;
    session_id?: string;
    model: string;
    turns?: number;
    duration_ms?: number;
    context_window_pct?: number;
    max_tokens?: number;
  }
): UsageEvent {
  let billing_fn: string;
  let input_tokens = 0;
  let output_tokens = 0;
  let cache_creation_tokens = 0;
  let cache_read_tokens = 0;
  let cache_hit_tokens: number | undefined;
  let cache_miss_tokens: number | undefined;
  let image_tokens: number | undefined;
  let total_context_tokens: number | undefined;

  if (raw.cache_hit_tokens != null || raw.cache_miss_tokens != null) {
    // DeepSeek 口径
    billing_fn = 'per_token_deepseek_v1';
    output_tokens = raw.output_tokens ?? raw.completion_tokens ?? 0;
    cache_hit_tokens = raw.cache_hit_tokens ?? 0;
    cache_miss_tokens = raw.cache_miss_tokens ?? 0;
    input_tokens = cache_miss_tokens; // 未命中部分才算 input（计费口径）
    // 实际上下文长度 = 命中 + 未命中（total KV cache input）
    total_context_tokens = cache_hit_tokens + cache_miss_tokens;

  } else if (raw.promptTokenCount != null || raw.candidatesTokenCount != null) {
    // Gemini 原生
    billing_fn = 'per_token_tiered_v1';
    input_tokens = raw.promptTokenCount ?? 0;
    output_tokens = raw.candidatesTokenCount ?? 0;
    cache_read_tokens = raw.cachedContentTokenCount ?? 0;
    total_context_tokens = raw.totalTokenCount ?? (input_tokens + output_tokens);

  } else if (raw.image_tokens != null) {
    // 视觉模型（Qwen-VL 等）
    billing_fn = 'per_token_image_v1';
    input_tokens = raw.input_tokens ?? raw.prompt_tokens ?? 0;
    output_tokens = raw.output_tokens ?? raw.completion_tokens ?? 0;
    image_tokens = raw.image_tokens;

  } else if (raw.cache_creation_input_tokens != null || raw.cache_read_input_tokens != null) {
    // Anthropic / Claude 原生
    billing_fn = 'per_token_v1';
    input_tokens = raw.input_tokens ?? 0;
    output_tokens = raw.output_tokens ?? 0;
    cache_creation_tokens = raw.cache_creation_input_tokens ?? 0;
    cache_read_tokens = raw.cache_read_input_tokens ?? 0;

  } else {
    // OpenAI 兼容降级（Kimi / MiniMax / 截断网关等）
    billing_fn = 'per_token_v1';
    input_tokens = raw.input_tokens ?? raw.prompt_tokens ?? 0;
    output_tokens = raw.output_tokens ?? raw.completion_tokens ?? 0;
    cache_read_tokens = raw.prompt_tokens_details?.cached_tokens ?? 0;
  }

  if (total_context_tokens == null) {
    total_context_tokens = input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens || undefined;
  }

  return {
    ts: meta.ts,
    agent_aid: meta.agent_aid,
    peer_key: meta.peer_key,
    peer_type: meta.peer_type,
    session_id: meta.session_id,
    model: meta.model,
    billing_fn,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    cache_hit_tokens,
    cache_miss_tokens,
    image_tokens,
    total_context_tokens,
    turns: meta.turns ?? 1,
    duration_ms: meta.duration_ms,
    context_window_pct: meta.context_window_pct,
  };
}
