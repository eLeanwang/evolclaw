# TS SDK 0.2.19 Changelog (相对于 0.2.16)

版本号从 0.2.16 直接跳到 0.2.19，中间没有独立的 0.2.17/0.2.18 发布提交。

---

## 一、日志体系重写（核心改动，19 个提交）

**新增/重写文件：**
- `src/logger.ts` — 按规范重写 AUNLogger（+205 行），支持：
  - 统一格式 `[yyyy-mm-dd HH:mm:ss.SSS][LEVEL][module] message`
  - 四级日志 ERROR/WARN/INFO/DEBUG
  - debug 开关控制输出行为
  - 文件日志（`{aun_path}/logs/{lang}-sdk-{yyyy-mm-dd}.log`）+ 7 天轮转
  - 全局配置 `~/.aun/log.ini` 支持（debug/level 覆盖）
  - `ModuleLogger` 接口，各子模块注入使用
  - 删除了未使用的 `setDebug` 方法 (YAGNI)

**全模块日志注入（替换所有 console.* 和自定义 _xxxLog）：**
- `src/client.ts` — 构造 AUNLogger，替换 `_clientLog`
- `src/auth.ts` — 注入 ModuleLogger，替换 `_authLog`
- `src/transport.ts` — 注入 ModuleLogger，替换 `console.warn`
- `src/e2ee.ts` — 注入 ModuleLogger 并分级
- `src/e2ee-group.ts` — 注入 ModuleLogger，替换 5 处 `console.warn`
- `src/keystore/file.ts` — 注入 ModuleLogger，替换 5 处 `console.*`
- `src/keystore/sqlite-backup.ts` — 注入 ModuleLogger，替换 5 处 `console.warn`
- `src/secret-store/file-store.ts` — 注入 ModuleLogger，替换 `console.log`

**module 命名规范对齐：**
- 各模块日志前缀统一为 `[aun_core.xxx]` 格式
- 清理 message 中的模块前缀冗余

**配置支持：**
- `src/config.ts` — AUNConfig 增加 `debug` 字段

**测试环境隔离：**
- `vitest.config.ts` — 单元测试环境设置 `AUN_LOG_INI_DISABLE=1`，避免本机 log.ini 影响 mock 断言

---

## 二、连接管理增强

**Gateway 长短连接 + 互踢 + extra_info：**
- `src/client.ts` — connect 支持 `extra_info` 参数，被踢时收到双方 extra_info
- `src/transport.ts` — 连接类型（长/短连接）支持增强（+91 行）

**Token 复用 / Gateway 复用：**
- `src/auth.ts` — token refresh 逻辑增强，支持 gateway 复用场景（+617 行变更）
- `src/namespaces/auth.ts` — auth namespace 大幅扩展（+245 行）

**Gateway Quota：**
- 集成测试验证 quota 限制行为

---

## 三、新增功能模块

| 文件 | 说明 |
|------|------|
| `src/group-id.ts` | 新增 GroupID 工具模块（+92 行） |
| `src/namespaces/meta.ts` | 新增 Meta namespace（+27 行） |
| `src/namespaces/custody.ts` | Custody namespace 扩展（+105 行） |

---

## 四、E2EE / Group E2EE 增强

- `src/e2ee.ts` — +80 行，prekey 缓存、replay guard 等
- `src/e2ee-group.ts` — +318 行，epoch rotation retry、membership gap 处理、pending decrypt 重试

---

## 五、其他改动

- `src/discovery.ts` — 服务发现逻辑调整（+34 行）
- `src/events.ts` — 事件类型扩展（+18 行）
- `src/keystore/index.ts` — 接口新增 `loadE2EEPrekeys`/`saveE2EEPrekey`/`loadSeq`/`loadAllSeqs`
- `src/keystore/aid-db.ts` — AID 数据库操作扩展（+40 行）
- `src/secret-store/index.ts` — 接口微调
- `src/client.ts` — error() 调用传入 Error 对象以保留调用栈

---

## 六、新增测试

| 测试文件 | 类型 | 说明 |
|----------|------|------|
| `tests/integration/extra-info.test.ts` | 集成 | 长连接互踢 extra_info 验证 |
| `tests/integration/gateway-quota.test.ts` | 集成 | Gateway quota 限制（+486 行） |
| `tests/integration/long-short.test.ts` | 集成 | 长短连接切换（+825 行） |
| `tests/integration/token-gateway-reuse.test.ts` | 集成 | Token/Gateway 复用（+306 行） |
| `tests/unit/config-debug.test.ts` | 单元 | debug 配置字段 |
| `tests/unit/connection-kind.test.ts` | 单元 | 连接类型判断（+157 行） |
| `tests/unit/gateway-disconnect-detail.test.ts` | 单元 | 断连详情事件（+102 行） |
| `tests/unit/logger-matrix.test.ts` | 单元 | Logger 输出矩阵验证（+110 行） |
| `tests/unit/token-gateway-reuse.test.ts` | 单元 | Token 复用逻辑（+195 行） |

**已有测试修改：**
- `tests/unit/logger.test.ts` — 大幅扩展（+102 行）
- `tests/unit/e2ee.test.ts` — 扩展（+116 行）
- `tests/unit/ts-audit-fixes.test.ts` — 调整
- `tests/integration/federation-storage.test.ts` — 微调

---

## 统计

- **37 个文件变更**（排除 package-lock）
- **+5018 行 / -849 行**
- 19 个中间提交
