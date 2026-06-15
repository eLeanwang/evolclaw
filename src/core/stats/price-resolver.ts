/**
 * price-resolver.ts — 统一价格解析逻辑，支持官方价格和网关价格。
 * 供 writer.ts 写入时调用，供 rebuild 命令回填历史数据。
 */

import { resolvePriceRow, BILLING_FNS, type PriceRecord, type BillingResult } from './billing.js';
import type { UsageEvent } from './normalizer.js';
import fs from 'fs';
import path from 'path';

/**
 * 网关价格缓存（从网关 /v1/models 接口获取）。
 * 每个网关维护一份内存缓存（1 小时 TTL）。
 */
export interface GatewayPricingCache {
  official: Map<string, PriceQuad>;   // pricing 字段（官方价格）
  gateway: Map<string, PriceQuad>;    // effective_pricing 字段（网关实际价格）
  usdToCny?: number;                  // 接口返回的汇率（usd_to_cny），缺失时计费层默认用 7
}

/** 价格四元组（统一格式：USD per 1M tokens） */
export interface PriceQuad {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  // DeepSeek 专用
  cache_hit?: number;
  cache_miss?: number;
  // 视觉模型专用
  image?: number;
}

/** 价格对：官方价格 + 网关价格 */
export interface PricePair {
  official: { usd: number; cny: number } | null;  // 官方价格（成本）
  gateway: { usd: number; cny: number } | null;   // 网关价格（实际收费）
}

// 网关价格表缓存（从用户覆盖层 model-prices-gateway.jsonl 读取）
let _gatewayPriceCache: PriceRecord[] | null = null;
let _gatewayPriceCacheTs = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000;

/**
 * 从用户覆盖层读取网关价格表（model-prices-gateway.jsonl）。
 * 这是用户通过 ECWeb "改价" 功能手动设置的网关价格。
 */
function loadGatewayPrices(evolclawHome: string): PriceRecord[] {
  const now = Date.now();
  if (_gatewayPriceCache && now - _gatewayPriceCacheTs < PRICE_CACHE_TTL) return _gatewayPriceCache;

  const userFile = path.join(evolclawHome, 'data', 'stats', 'model-prices-gateway.jsonl');
  if (!fs.existsSync(userFile)) {
    _gatewayPriceCache = [];
    _gatewayPriceCacheTs = now;
    return [];
  }

  try {
    const lines = fs.readFileSync(userFile, 'utf-8').split('\n').filter(Boolean);
    _gatewayPriceCache = lines.map(l => JSON.parse(l) as PriceRecord);
    _gatewayPriceCacheTs = now;
    return _gatewayPriceCache;
  } catch {
    _gatewayPriceCache = [];
    _gatewayPriceCacheTs = now;
    return [];
  }
}

/**
 * 从用户覆盖层查找网关价格（优先级高于网关接口返回）。
 */
function resolveGatewayPriceRow(evolclawHome: string, model: string, ts: number): PriceRecord | null {
  const prices = loadGatewayPrices(evolclawHome);
  const candidates = prices.filter(p => p.model === model && p.effective_from <= ts);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => a.effective_from >= b.effective_from ? a : b);
}

/**
 * 从 PriceQuad 构造一个符合 billing.ts 规范的 PriceRecord。
 * 用于将网关接口返回的价格四元组转换为可用于 calcCost() 的格式。
 */
function priceQuadToRecord(model: string, ts: number, quad: PriceQuad, billing_fn: string, currency: 'USD' | 'CNY' = 'USD'): PriceRecord {
  return {
    model,
    effective_from: ts,
    billing_fn,
    currency,
    price_input: quad.input ?? 0,
    price_output: quad.output ?? 0,
    price_cache_creation: quad.cache_write ?? 0,
    price_cache_read: quad.cache_read ?? 0,
    price_cache_hit: quad.cache_hit,
    price_cache_miss: quad.cache_miss,
    price_image: quad.image,
  };
}

/**
 * 解析官方价格和网关价格。
 *
 * @param evolclawHome - EvolClaw 根目录
 * @param event - 使用事件（含 model, billing_fn, ts, token 量）
 * @param gatewayPricing - 可选的网关价格缓存（从网关接口获取）
 * @returns 官方价格和网关价格的费用对
 */
export function resolvePrices(
  evolclawHome: string,
  event: UsageEvent,
  gatewayPricing?: GatewayPricingCache
): PricePair {
  // ── 1. 官方价格（Official Price）──────────────────────────────────────────
  let officialCost: BillingResult | null = null;

  // 优先级 1: 网关接口返回的 pricing 字段
  if (gatewayPricing?.official.has(event.model)) {
    const quad = gatewayPricing.official.get(event.model)!;
    const priceRow = priceQuadToRecord(event.model, event.ts, quad, event.billing_fn);
    const fn = BILLING_FNS[event.billing_fn];
    if (fn) {
      officialCost = fn(event, priceRow);
    }
  }

  // 优先级 2: 本地 model-prices.jsonl（包基线 + 用户覆盖层）
  if (!officialCost) {
    const priceRow = resolvePriceRow(evolclawHome, event.model, event.ts);
    if (priceRow) {
      const fn = BILLING_FNS[event.billing_fn] ?? BILLING_FNS[priceRow.billing_fn];
      if (fn) {
        officialCost = fn(event, priceRow);
      }
    }
  }

  // ── 2. 网关价格（Gateway Effective Price）────────────────────────────────
  let gatewayCost: BillingResult | null = null;

  // 优先级 1: 用户手动设置的网关价格（model-prices-gateway.jsonl）
  const gatewayPriceRow = resolveGatewayPriceRow(evolclawHome, event.model, event.ts);
  if (gatewayPriceRow) {
    const fn = BILLING_FNS[event.billing_fn] ?? BILLING_FNS[gatewayPriceRow.billing_fn];
    if (fn) {
      gatewayCost = fn(event, gatewayPriceRow);
    }
  }

  // 优先级 2: 网关接口返回的 effective_pricing 字段
  if (!gatewayCost && gatewayPricing?.gateway.has(event.model)) {
    const quad = gatewayPricing.gateway.get(event.model)!;
    const priceRow = priceQuadToRecord(event.model, event.ts, quad, event.billing_fn);
    const fn = BILLING_FNS[event.billing_fn];
    if (fn) {
      gatewayCost = fn(event, priceRow);
    }
  }

  // 优先级 3: 回退到官方价格（实际收费 = 成本价）
  if (!gatewayCost) {
    gatewayCost = officialCost;
  }

  // ── 3. 转换为统一格式 ───────────────────────────────────────────────────
  // 计费函数按价格行币种只产出一种货币（接口价恒为 USD）。用网关汇率(usd_to_cny，缺省 7)
  // 补齐另一种货币：有 usd 缺 cny → cny=usd*rate；有 cny 缺 usd → usd=cny/rate。
  const rate = (typeof gatewayPricing?.usdToCny === 'number' && gatewayPricing.usdToCny > 0)
    ? gatewayPricing.usdToCny : 7;
  const toPair = (c: BillingResult | null): { usd: number; cny: number } | null => {
    if (!c) return null;
    const hasUsd = typeof c.usd === 'number';
    const hasCny = typeof c.cny === 'number';
    const usd = hasUsd ? c.usd! : (hasCny ? c.cny! / rate : 0);
    const cny = hasCny ? c.cny! : (hasUsd ? c.usd! * rate : 0);
    return { usd, cny };
  };
  return {
    official: toPair(officialCost),
    gateway: toPair(gatewayCost),
  };
}
