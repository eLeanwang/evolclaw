/**
 * billing.ts — 读 model-prices.jsonl，按 billing_fn 调对应算法函数计算费用。
 * 费用查询时实时计算，不存入 DB（价格可能变动）。
 */

import fs from 'fs';
import path from 'path';
import { getPackageRoot } from '../paths.js';

export interface PriceRecord {
  model: string;
  effective_from: number;
  billing_fn: string;
  currency: 'USD' | 'CNY';
  [key: string]: unknown;
}

export interface BillingResult {
  usd?: number;
  cny?: number;
}

// 价格表缓存（进程内，5 分钟 TTL）
let _priceCache: PriceRecord[] | null = null;
let _priceCacheTs = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000;

/**
 * 从包路径 + 用户路径合并读取 JSONL 文件。
 * 包路径（$PACKAGE_ROOT/data/stats/）为基线，用户路径（$EVOLCLAW_HOME/data/stats/）为追加/覆盖。
 * 两层合并（append），用户层行追加在包层之后——查价时 effective_from 越大越优先，天然正确。
 */
function _loadJsonlMerged<T>(evolclawHome: string, filename: string): T[] {
  const results: T[] = [];
  // 1. 包路径（基线）
  const pkgFile = path.join(getPackageRoot(), 'data', 'stats', filename);
  if (fs.existsSync(pkgFile)) {
    try {
      const lines = fs.readFileSync(pkgFile, 'utf-8').split('\n').filter(Boolean);
      for (const l of lines) results.push(JSON.parse(l) as T);
    } catch { /* skip */ }
  }
  // 2. 用户路径（追加/覆盖）
  const userFile = path.join(evolclawHome, 'data', 'stats', filename);
  if (fs.existsSync(userFile)) {
    try {
      const lines = fs.readFileSync(userFile, 'utf-8').split('\n').filter(Boolean);
      for (const l of lines) results.push(JSON.parse(l) as T);
    } catch { /* skip */ }
  }
  return results;
}

// ── Model Aliases（模型 ID 映射：带日期编号 → 定价表规范 ID）────────────────

interface ModelAlias {
  alias: string;      // 实际返回的 model id（如 "claude-opus-4-8-20250514"）
  canonical: string;  // 定价表中的 model id（如 "claude-opus-4-8"）
}

let _aliasCache: ModelAlias[] | null = null;
let _aliasCacheTs = 0;

function loadAliases(evolclawHome: string): ModelAlias[] {
  const now = Date.now();
  if (_aliasCache && now - _aliasCacheTs < PRICE_CACHE_TTL) return _aliasCache;
  _aliasCache = _loadJsonlMerged<ModelAlias>(evolclawHome, 'model-aliases.jsonl');
  _aliasCacheTs = now;
  return _aliasCache;
}

/** 解析模型 ID → 定价表规范 ID。精确匹配 alias 表，找不到返回原 ID。 */
export function resolveCanonicalModel(evolclawHome: string, model: string): string {
  const aliases = loadAliases(evolclawHome);
  const entry = aliases.find(a => a.alias === model);
  return entry ? entry.canonical : model;
}

function loadPrices(evolclawHome: string): PriceRecord[] {
  const now = Date.now();
  if (_priceCache && now - _priceCacheTs < PRICE_CACHE_TTL) return _priceCache;
  _priceCache = _loadJsonlMerged<PriceRecord>(evolclawHome, 'model-prices.jsonl');
  _priceCacheTs = now;
  return _priceCache;
}

/** 取 model 在 ts 时刻生效的价格行（effective_from <= ts 中最新的一条）。
 *  精确匹配失败时，通过 model-aliases.jsonl 映射到规范 ID 再查一次。 */
export function resolvePriceRow(evolclawHome: string, model: string, ts: number): PriceRecord | null {
  const prices = loadPrices(evolclawHome);
  let candidates = prices.filter(p => p.model === model && p.effective_from <= ts);
  if (!candidates.length) {
    // fallback: alias → canonical
    const canonical = resolveCanonicalModel(evolclawHome, model);
    if (canonical !== model) {
      candidates = prices.filter(p => p.model === canonical && p.effective_from <= ts);
    }
  }
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => a.effective_from >= b.effective_from ? a : b);
}

// ── 计费函数注册表 ────────────────────────────────────────────────────────────

type BillingFn = (event: BillingInput, price: PriceRecord) => BillingResult;

interface BillingInput {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  image_tokens?: number;
  total_context_tokens?: number;
}

export const BILLING_FNS: Record<string, BillingFn> = {
  // 通用 per-token（Claude / OpenAI 兼容 / Kimi / MiniMax）
  per_token_v1: (e, p) => {
    const r = (p.price_input as number ?? 0) * e.input_tokens / 1e6
            + (p.price_output as number ?? 0) * e.output_tokens / 1e6
            + (p.price_cache_creation as number ?? 0) * e.cache_creation_tokens / 1e6
            + (p.price_cache_read as number ?? 0) * e.cache_read_tokens / 1e6;
    return p.currency === 'CNY' ? { cny: r } : { usd: r };
  },

  // DeepSeek cache_hit / cache_miss 口径
  per_token_deepseek_v1: (e, p) => {
    const r = (p.price_cache_hit as number ?? 0) * (e.cache_hit_tokens ?? 0) / 1e6
            + (p.price_cache_miss as number ?? 0) * (e.cache_miss_tokens ?? 0) / 1e6
            + (p.price_output as number ?? 0) * e.output_tokens / 1e6;
    return { cny: r };
  },

  // Gemini 分档（按 total_context_tokens 确定所在档位）
  per_token_tiered_v1: (e, p) => {
    const tiers = p.tiers as Array<{ up_to_tokens: number | null; price_input: number; price_output: number; price_cache_read?: number }>;
    if (!Array.isArray(tiers)) return {};
    const ctx = e.total_context_tokens ?? e.input_tokens;
    const tier = tiers.find(t => t.up_to_tokens == null || ctx <= t.up_to_tokens) ?? tiers[tiers.length - 1];
    const r = (tier.price_input ?? 0) * e.input_tokens / 1e6
            + (tier.price_output ?? 0) * e.output_tokens / 1e6
            + (tier.price_cache_read ?? 0) * e.cache_read_tokens / 1e6;
    return p.currency === 'CNY' ? { cny: r } : { usd: r };
  },

  // 视觉模型（含 image_tokens 单独计费）
  per_token_image_v1: (e, p) => {
    const r = (p.price_input as number ?? 0) * e.input_tokens / 1e6
            + (p.price_output as number ?? 0) * e.output_tokens / 1e6
            + (p.price_image as number ?? 0) * (e.image_tokens ?? 0) / 1e6;
    return p.currency === 'CNY' ? { cny: r } : { usd: r };
  },
};

/** 注册新计费函数（扩展点）。 */
export function registerBillingFn(id: string, fn: BillingFn): void {
  BILLING_FNS[id] = fn;
}

/** 计算一条 usage_event 的费用。找不到价格行时返回 {}。 */
export function calcCost(evolclawHome: string, event: BillingInput & { model: string; billing_fn: string; ts: number }): BillingResult {
  const priceRow = resolvePriceRow(evolclawHome, event.model, event.ts);
  if (!priceRow) return {};
  const fn = BILLING_FNS[event.billing_fn] ?? BILLING_FNS[priceRow.billing_fn];
  if (!fn) return {};
  return fn(event, priceRow);
}

// ── Model Specs ──────────────────────────────────────────────────────────────

export interface ModelSpec {
  model: string;
  effective_from: number;
  context_window: number;
  max_input_tokens: number;
  max_output_tokens: number;
  supports_cache?: boolean;
  supports_vision?: boolean;
}

let _specCache: ModelSpec[] | null = null;
let _specCacheTs = 0;

function loadSpecs(evolclawHome: string): ModelSpec[] {
  const now = Date.now();
  if (_specCache && now - _specCacheTs < PRICE_CACHE_TTL) return _specCache;
  _specCache = _loadJsonlMerged<ModelSpec>(evolclawHome, 'model-specs.jsonl');
  _specCacheTs = now;
  return _specCache;
}

/** 取模型在 ts 时刻的能力参数。找不到时返回默认值。 */
export function resolveModelSpec(evolclawHome: string, model: string, ts?: number): ModelSpec {
  const specs = loadSpecs(evolclawHome);
  const t = ts ?? Date.now();
  const candidates = specs.filter(s => s.model === model && s.effective_from <= t);
  if (candidates.length) {
    return candidates.reduce((a, b) => a.effective_from >= b.effective_from ? a : b);
  }
  // 默认值
  return { model, effective_from: 0, context_window: 200000, max_input_tokens: 180000, max_output_tokens: 8192 };
}
