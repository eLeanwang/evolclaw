/**
 * schema-registry —— 配置 schema 的唯一加载入口（SSOT）。
 *
 * schema 文件位于 kits/schemas/，命名 `{逻辑名}.schema.{版本}.json`，随 npm 包分发。
 * 每个字段带：
 *   - 标准 JSON Schema `type`（ajv 校验用）
 *   - `x-merge`：合并语义（scalar / list / dict），覆盖链类型驱动合并的依据
 * schema 根带：
 *   - `x-logical-name` / `x-scope`
 *
 * v3 设计：所有参数统一在 config.json，按作用域路由到对应层级。
 */

import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { kitsSchemasDir } from '../paths.js';

export type LogicalSchemaName =
  | 'evolclaw'
  | 'defaults'
  | 'agent-config'
  | 'relation-config'
  | 'contact-book'
  // 响应模式桶 schema：不绑 config.json 文件（不进 TARGET_SCHEMA），
  // 只描述 responseModeParams[modeId] 桶的形状——供 config schema 子命令展示、
  // 桶专项校验、schemaDefaults 提取默认。每个已实现的响应模式一份。
  | 'single-session';

export type MergeKind = 'scalar' | 'list' | 'dict';

export interface FieldSpec {
  name: string;
  type: string | string[];
  merge: MergeKind;
  enum?: string[];
  default?: unknown;
  description?: string;
}

export interface SchemaEntry {
  logicalName: LogicalSchemaName;
  version: number;
  scope: string;
  raw: any;
  validate: ValidateFunction;
  /** 顶层字段名 → 规格（含 merge 语义）。 */
  fields: Map<string, FieldSpec>;
}

interface MetaJson {
  schemas: Record<string, { currentVersion: number }>;
  history: Array<{ schema: string; version: number; date: string; description: string }>;
}

let _ajv: Ajv | null = null;
function ajv(): Ajv {
  if (!_ajv) {
    _ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
  }
  return _ajv;
}

let _meta: MetaJson | null = null;
export function loadMeta(): MetaJson {
  if (_meta) return _meta;
  const p = path.join(kitsSchemasDir(), '_meta.json');
  _meta = JSON.parse(fs.readFileSync(p, 'utf-8')) as MetaJson;
  return _meta;
}

/** 某 schema 的当前版本号（来自 _meta.json）。 */
export function currentVersion(name: LogicalSchemaName): number {
  const meta = loadMeta();
  const v = meta.schemas[name]?.currentVersion;
  if (typeof v !== 'number') throw new Error(`[schema] no currentVersion for "${name}" in _meta.json`);
  return v;
}

/** 全部逻辑 schema 名（来自 _meta.json，键序）。 */
export function listSchemaNames(): LogicalSchemaName[] {
  return Object.keys(loadMeta().schemas) as LogicalSchemaName[];
}

/** 是否为已知逻辑 schema 名。 */
export function isSchemaName(name: string): name is LogicalSchemaName {
  return Object.prototype.hasOwnProperty.call(loadMeta().schemas, name);
}

/**
 * 顶层字段的 schema 声明默认值（`default` 关键字），无则 undefined。
 * 仅覆盖顶层标量字段——嵌套路径的默认值不在此解析。
 * 用于 `ec config get` 在各存储层都无值时回落展示出厂默认。
 */
export function fieldSchemaDefault(name: LogicalSchemaName, fieldPath: string): unknown {
  if (fieldPath.includes('.')) return undefined;
  const spec = loadSchema(name).fields.get(fieldPath);
  return spec && 'default' in spec ? spec.default : undefined;
}

/** 某版本的 history 元信息（date/description），无则 undefined。 */
export function schemaHistoryEntry(
  name: LogicalSchemaName,
  version: number,
): { date: string; description: string } | undefined {
  const entry = loadMeta().history.find(h => h.schema === name && h.version === version);
  return entry ? { date: entry.date, description: entry.description } : undefined;
}

/** 扫描 kits/schemas/ 得到某 schema 磁盘上存在的版本号（升序）。 */
export function listSchemaVersions(name: LogicalSchemaName): number[] {
  const prefix = `${name}.schema.`;
  const suffix = '.json';
  const versions: number[] = [];
  for (const file of fs.readdirSync(kitsSchemasDir())) {
    if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
    const middle = file.slice(prefix.length, file.length - suffix.length);
    if (!/^\d+$/.test(middle)) continue;
    versions.push(Number(middle));
  }
  return versions.sort((a, b) => a - b);
}

/** 读指定版本的原始 schema（解析为对象，用于内容展示，不做 ajv 编译）。 */
export function readRawSchema(name: LogicalSchemaName, version: number): unknown {
  const file = schemaFilePath(name, version);
  if (!fs.existsSync(file)) {
    throw new Error(`[schema] no schema file for "${name}" v${version}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const _cache = new Map<string, SchemaEntry>();

function schemaFilePath(name: LogicalSchemaName, version: number): string {
  return path.join(kitsSchemasDir(), `${name}.schema.${version}.json`);
}

function extractFields(raw: any): Map<string, FieldSpec> {
  const fields = new Map<string, FieldSpec>();
  const props = raw.properties || {};
  for (const [name, spec] of Object.entries<any>(props)) {
    if (name === '$schema_version') continue;
    const merge: MergeKind = (spec['x-merge'] as MergeKind) || inferMerge(spec);
    fields.set(name, {
      name,
      type: spec.type,
      merge,
      enum: spec.enum,
      default: spec.default,
      description: spec.description,
    });
  }
  return fields;
}

/** 无 x-merge 时按 JSON Schema type 兜底推断合并语义。 */
function inferMerge(spec: any): MergeKind {
  if (spec.type === 'array') return 'list';
  if (spec.type === 'object') return 'dict';
  return 'scalar';
}

/** 加载指定版本的 schema entry（带 ajv 编译 + 字段表）。 */
export function loadSchema(name: LogicalSchemaName, version?: number): SchemaEntry {
  const ver = version ?? currentVersion(name);
  const key = `${name}@${ver}`;
  const cached = _cache.get(key);
  if (cached) return cached;

  const file = schemaFilePath(name, ver);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const entry: SchemaEntry = {
    logicalName: name,
    version: ver,
    scope: raw['x-scope'] || name,
    raw,
    validate: ajv().compile(raw),
    fields: extractFields(raw),
  };
  _cache.set(key, entry);
  return entry;
}

/** extra_backup 不得指向 .env（构建期校验）——遍历声明里的 pattern。 */
export function assertExtraBackupNotEnv(extraBackup: Array<{ path?: string; pattern?: string }> | undefined): void {
  if (!extraBackup) return;
  for (const e of extraBackup) {
    const pat = (e.pattern || '').toLowerCase();
    const pth = (e.path || '').toLowerCase();
    if (pat.includes('.env') || pth.endsWith('.env') || pat === '*') {
      throw new Error(`[schema] extra_backup 不得指向 .env: ${JSON.stringify(e)}`);
    }
  }
}

/** 测试用：清空缓存。 */
export function _resetSchemaCache(): void {
  _cache.clear();
  _meta = null;
  _ajv = null;
}
