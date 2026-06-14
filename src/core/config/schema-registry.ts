/**
 * schema-registry —— 配置 schema 的唯一加载入口（SSOT）。
 *
 * schema 文件位于 kits/schemas/，命名 `{逻辑名}.schema.{版本}.json`，随 npm 包分发。
 * 每个字段带：
 *   - 标准 JSON Schema `type`（ajv 校验用）
 *   - `x-merge`：合并语义（scalar / list / dict），覆盖链类型驱动合并的依据（design §三）
 * schema 根带：
 *   - `x-logical-name` / `x-permission`(H|HA) / `x-scope`
 *
 * 「字段 →（类型, 归属文件）」由「字段出现在哪个 schema」决定（design §六物理分离）。
 * 硬约束（构建期/加载期 assert）：agent-config ∩ behavior、relation-config ∩ behavior 字段名严格不相交。
 */

import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { kitsSchemasDir } from '../../paths.js';

export type LogicalSchemaName =
  | 'evolclaw'
  | 'defaults'
  | 'agent-config'
  | 'relation-config'
  | 'behavior';

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
  permission: 'H' | 'HA';
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
    permission: (raw['x-permission'] as 'H' | 'HA') || 'H',
    scope: raw['x-scope'] || name,
    raw,
    validate: ajv().compile(raw),
    fields: extractFields(raw),
  };
  _cache.set(key, entry);
  return entry;
}

/**
 * 硬约束校验：同一作用域的 config schema 与 behavior schema 字段名空间必须严格不相交。
 * 只作用在有双文件的作用域（agent / relation）；defaults / evolclaw 是单 H 文件，不参与。
 * 加载期调用一次（ConfigManager 初始化）；失败抛错（开发期暴露手滑）。
 */
export function assertDisjointFields(): void {
  const behavior = loadSchema('behavior');
  const bKeys = new Set(behavior.fields.keys());
  for (const cfgName of ['agent-config', 'relation-config'] as LogicalSchemaName[]) {
    const cfg = loadSchema(cfgName);
    const overlap = [...cfg.fields.keys()].filter(k => bKeys.has(k));
    if (overlap.length > 0) {
      throw new Error(
        `[schema] field-name collision between "${cfgName}" and "behavior": ${overlap.join(', ')} ` +
        `(每个字段必须唯一归属 config(H) 或 behavior(HA))`,
      );
    }
  }
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
