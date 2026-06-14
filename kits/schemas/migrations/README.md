# Schema 版本迁移函数

每次某 schema 升版（`_meta.json` 里 currentVersion 上升）必须提供配套迁移函数。

## 命名

```
{schema}.{N}-to-{N+1}.ts
```

例：`agent-config.1-to-2.ts`。

## 契约（整文件 in/out）

```typescript
export function migrate(old: object): object;   // 旧版本完整 JSON → 新版本完整 JSON
```

- 入参/返回都是**完整对象**——整体重写，不做字段级 patch。
- 迁移产物直接覆盖原文件（ConfigManager 在迁移前已建 schema-migration 快照保证可回滚），写回后更新 `$schema_version`。
- 多版本串联即函数复合：`v1→v3 = migrate_2to3(migrate_1to2(old))`，逐版本串联，不跨版本直跳。

## 要求

- 历史 schema 文件全部保留（`{逻辑名}.schema.{版本}.json`）。
- 每个迁移函数 default-export `migrate`，由 ConfigManager 动态 import。

当前所有 schema 均为 v1，无迁移函数。
