/**
 * merge —— 类型驱动的覆盖链合并（design §三，全项目唯一实现点）+ ${VAR} 展开。
 *
 * 合并三规则（按字段的 x-merge 语义）：
 *   - scalar：高优先级整体覆盖
 *   - list：  并集追加去重（只能加，不能减）
 *   - dict：  键并集；同键 → 高优先级值直接覆盖（**不递归**，合并粒度=第一层键）
 *
 * 合并代码永远只有这三条规则；所有"覆盖 vs 追加"通过 schema 的 x-merge 选择表达，不为字段写特判。
 */

import fs from 'fs';
import path from 'path';
import type { FieldSpec, SchemaEntry } from './schema-registry.js';

/** list 并集去重——标量元素按值去重；对象元素按 JSON 串去重。 */
function unionList(base: unknown[], overlay: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const keyOf = (v: unknown) =>
    (v !== null && typeof v === 'object') ? JSON.stringify(v) : `${typeof v}:${String(v)}`;
  for (const v of [...base, ...overlay]) {
    const k = keyOf(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** dict 第一层键合并：键并集，同键高优先级整体覆盖（不递归）。 */
function mergeDict(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = v;
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 按 schema 字段表，对覆盖链上"存在的每一级"做类型驱动合并。
 * layers 从低优先级到高优先级；低优先级独有字段保留，冲突点高优先级胜。
 * 字段未在 schema 中（理论上 ajv 已拦）按 scalar 处理。
 */
export function mergeLayers<T extends Record<string, any>>(
  layers: Array<Partial<T> | null | undefined>,
  fields: Map<string, FieldSpec>,
): T {
  const out: Record<string, any> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      const spec = fields.get(k);
      const kind = spec?.merge ?? 'scalar';
      const prev = out[k];
      if (prev === undefined) {
        out[k] = v;
        continue;
      }
      if (kind === 'list' && Array.isArray(prev) && Array.isArray(v)) {
        out[k] = unionList(prev, v);
      } else if (kind === 'dict' && isPlainObject(prev) && isPlainObject(v)) {
        out[k] = mergeDict(prev, v);
      } else {
        out[k] = v; // scalar 覆盖（或类型不一致时高优先级胜）
      }
    }
  }
  return out as T;
}

// ── ${VAR} 三级 .env 展开（design §五）─────────────────────────────────────
//
// 仅支持 ${VAR}（废弃旧 $ENV:NAME）。解析优先级：
//   关系级 .env > agent 级 .env > 全局 .env > 进程环境变量
// 展开只发生在运行时内部消费路径（read 的 expand=true），CLI 读路径不展开。

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const _warnedVars = new Set<string>();

/** 解析单个 .env 文件为 KV（极简：KEY=VALUE，忽略注释/空行，去引号）。不存在返回 {}。 */
function parseEnvFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export interface EnvScope {
  /** 关系级 .env 目录（agents/<aid>/relations/<peerKey>/.env） */
  relationDir?: string;
  /** agent 级 .env 目录（agents/<aid>/.env） */
  agentDir?: string;
  /** 全局 .env 目录（{root}/.env） */
  rootDir?: string;
}

/**
 * 构造 ${VAR} 查值器：按 关系 > agent > 全局 > process.env 优先级，首个命中为准。
 */
export function buildEnvResolver(scope: EnvScope): (name: string) => string | undefined {
  const layers: Record<string, string>[] = [];
  if (scope.relationDir) layers.push(parseEnvFile(path.join(scope.relationDir, '.env')));
  if (scope.agentDir) layers.push(parseEnvFile(path.join(scope.agentDir, '.env')));
  if (scope.rootDir) layers.push(parseEnvFile(path.join(scope.rootDir, '.env')));
  return (name: string): string | undefined => {
    for (const l of layers) {
      if (Object.prototype.hasOwnProperty.call(l, name)) return l[name];
    }
    return process.env[name];
  };
}

/**
 * 递归展开对象中所有 ${VAR} 引用。缺失变量沿用"warn 一次 + 当空字符串"语义。
 * resolver 缺省（仅 process.env）时也可用。
 */
export function expandVars<T>(value: T, resolve: (name: string) => string | undefined): T {
  return walk(value, resolve) as T;
}

function walk(v: any, resolve: (name: string) => string | undefined): any {
  if (typeof v === 'string') {
    return v.replace(VAR_RE, (_m, name: string) => {
      const got = resolve(name);
      if (got === undefined) {
        if (!_warnedVars.has(name)) {
          // 延迟 import logger 会引入循环；直接 console.warn（与现有 config 行为一致级别）
          console.warn(`[config] env "${name}" not set; \${${name}} expands to empty`);
          _warnedVars.add(name);
        }
        return '';
      }
      return got;
    });
  }
  if (Array.isArray(v)) return v.map(x => walk(x, resolve));
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val, resolve);
    return out;
  }
  return v;
}

/** 测试用：复位 warn 去重集。 */
export function _resetEnvWarnings(): void {
  _warnedVars.clear();
}

/** 导出供 schema-entry 合并用：从 SchemaEntry 取字段表的便捷封装。 */
export function fieldsOf(entry: SchemaEntry): Map<string, FieldSpec> {
  return entry.fields;
}
