# 模型价格体系

## 概述

EvolClaw 的模型价格体系分为**三层**：

1. **官方价格**：模型提供商的原始定价
2. **网关价格**：经过网关倍率或自定义调整后的价格
3. **计费价格**：实际用于 usage.db 记账的价格（与官方价格一致，用于成本核算）

价格数据有**三级回退机制**，确保在各种场景下都能拿到价格信息。

---

## 价格数据来源（三级回退）

### 优先级 1：网关接口返回（`/v1/models` 的 `pricing` / `effective_pricing`）

当网关支持价格查询接口时（如 ModelGate 的 9998/9999 端口），从 `/v1/models` 解析：

```json
{
  "id": "claude-opus-4-8",
  "pricing": {
    "input": 15.0,
    "output": 75.0,
    "cache_read": 1.5,
    "cache_write": 18.75,
    "unit": "USD / 1M tokens"
  },
  "effective_pricing": {
    "input": 30.0,
    "output": 150.0,
    "cache_read": 3.0,
    "cache_write": 37.5,
    "unit": "USD / 1M tokens"
  }
}
```

- **`pricing`**：官方原价
- **`effective_pricing`**：网关应用倍率后的价格（供用户参考，不强制用于计费）

**触发条件**：网关返回符合上述格式的模型列表。

**实现位置**：`src/core/message/command-handler-gateway-control.ts` → `gatewayModels()` → `apiPricingToQuad(m?.pricing)`

---

### 优先级 2：本地价格表（`model-prices.jsonl`）

网关未返回价格时，回退到 EvolClaw 自己维护的官方价格表。

**文件位置**：
- **包基线**（只读）：`data/stats/model-prices.jsonl`（源码 `src/data/stats/`，build 时 copy）
- **用户覆盖层**（可写）：`$EVOLCLAW_HOME/data/stats/model-prices.jsonl`

#### 格式（JSONL，每行一条记录）

```jsonl
{"model":"claude-opus-4-8","effective_from":0,"billing_fn":"per_token_v1","currency":"USD","price_input":15,"price_output":75,"price_cache_creation":18.75,"price_cache_read":1.5}
{"model":"deepseek-v4-pro","effective_from":0,"billing_fn":"per_token_deepseek_v1","currency":"CNY","price_cache_hit":0.5,"price_cache_miss":2,"price_output":8}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 模型 ID，唯一标识 |
| `effective_from` | int | 生效时间戳（ms）。查价时取 `effective_from ≤ now` 的最新记录 |
| `billing_fn` | string | 计费算法：`per_token_v1`（通用）/ `per_token_deepseek_v1`（deepseek 缓存模型） |
| `currency` | string | 币种：`USD` / `CNY` |
| `price_input` | float | 输入 token 价格（per_token_v1） |
| `price_output` | float | 输出 token 价格 |
| `price_cache_creation` | float | 缓存写入价格（对应 Claude 的 cache_write） |
| `price_cache_read` | float | 缓存读取价格 |
| `price_cache_hit` | float | 缓存命中价格（deepseek_v1） |
| `price_cache_miss` | float | 缓存未命中价格（deepseek_v1） |

#### 合并规则

- 用户覆盖层的记录（`effective_from` 更新）覆盖包基线
- 同一 `model` 多条记录时，取 `effective_from ≤ now` 的最新一条

**实现位置**：`src/core/stats/billing.ts` → `_loadJsonlMerged()` + `resolvePriceRow()`

---

### 优先级 3：显示「—」+ 用户手动填写

前两级都拿不到价格时，UI 显示「—」，用户可通过 **「改价」按钮** 手动设置网关价格，写入用户覆盖层 `model-prices.jsonl`。

**触发条件**：网关不返回价格 **且** 本地表没有该模型。

**手动设置流程**：
1. ECWeb Gateway 页 → 点某 agent 的「查看网关配置」
2. 模型列表中找到目标模型 → 点「改价」
3. 输入四个价格字段（input / output / cache_read / cache_write）
4. 保存 → append 一条新记录到 `$EVOLCLAW_HOME/data/stats/model-prices.jsonl`，`effective_from=now`

**实现位置**：
- daemon: `src/core/message/command-handler-gateway-control.ts` → `gatewaySetPrice()`
- 前端: `ecweb/src/static/app.js` → `showPriceEditModal()`

---

## 价格字段映射

不同数据源的字段名不一致，统一映射为展示用的四元组：

| 展示字段 | 网关接口字段 | JSONL 字段（per_token_v1） | 说明 |
|---|---|---|---|
| Input | `pricing.input` | `price_input` | 输入 token 单价 |
| Output | `pricing.output` | `price_output` | 输出 token 单价 |
| Cache Read | `pricing.cache_read` | `price_cache_read` | 缓存读取单价 |
| Cache Write | `pricing.cache_write` | `price_cache_creation` | 缓存写入单价 |

**单位统一为**：USD / 1M tokens（或 CNY / 1M tokens，取决于 `currency` 字段）

---

## 已内置的价格基线（17 个模型）

`data/stats/model-prices.jsonl` 包含以下模型的官方价格（截至 2026-06-14）：

### Claude 系列（USD）

| 模型 | Input | Output | Cache Read | Cache Write |
|---|---|---|---|---|
| claude-opus-4-8 | 15 | 75 | 1.5 | 18.75 |
| claude-opus-4-7 | 15 | 75 | 1.5 | 18.75 |
| claude-opus-4-6 | 15 | 75 | 1.5 | 18.75 |
| claude-sonnet-4-6 | 3 | 15 | 0.3 | 3.75 |
| claude-haiku-4-5-20251001 | 0.8 | 4 | 0.08 | 1 |

### GPT 系列（USD）

| 模型 | Input | Output |
|---|---|---|
| gpt-5.5 | 2 | 10 |
| gpt-5.4 | 2 | 10 |
| gpt-5.3-codex | 2 | 10 |

### DeepSeek 系列（CNY，特殊计费算法）

| 模型 | Cache Hit | Cache Miss | Output |
|---|---|---|---|
| deepseek-v4-pro | 0.5 | 2 | 8 |
| deepseek-v4-flash | 0.1 | 0.5 | 2 |
| deepseek-v3.2 | 0.5 | 2 | 8 |

### 国产其他模型（CNY）

| 模型 | Input | Output |
|---|---|---|
| kimi-k2.6 | 2 | 8 |
| kimi-k2.5 | 2 | 8 |
| glm-5.1 | 5 | 20 |
| glm-5 | 5 | 20 |
| glm-4.7 | 1 | 5 |
| MiniMax-M2.7 | 1 | 5 |

---

## 价格更新流程

### 1. 更新包基线价格（开发者）

**场景**：模型提供商调价、新增模型

**步骤**：
1. 编辑 `src/data/stats/model-prices.jsonl`，追加或修改记录
2. 同步到项目根 `data/stats/model-prices.jsonl`（`cp src/data/stats/model-prices.jsonl data/stats/`）
3. `npm run build`（自动 copy 到 `dist/data/stats/`）
4. 发布新版本

**注意**：`effective_from` 设为 0（永久生效）或未来时间戳（定时调价）。

### 2. 用户覆盖价格（运维/终端用户）

**场景**：
- 网关与官方价格不一致（自定义倍率、优惠）
- 包基线未及时更新
- 本地测试临时价格

**步骤**：
1. ECWeb Gateway 页 → 「查看网关配置」 → 「改价」
2. 或手动编辑 `$EVOLCLAW_HOME/data/stats/model-prices.jsonl`，追加记录：
   ```jsonl
   {"model":"claude-opus-4-8","effective_from":1718366400000,"billing_fn":"per_token_v1","currency":"USD","price_input":12,"price_output":60,"price_cache_creation":15,"price_cache_read":1.2}
   ```
3. 重启 daemon 或等待缓存过期（5 分钟 TTL）

**优先级**：用户覆盖层自动覆盖包基线（`effective_from` 更新的胜出）。

---

## 计费系统集成

价格数据主要供 **ECWeb 展示** 和 **未来的计费模块** 使用。当前 `usage.db` 只记录 token 消耗量，不存价格。

### 计费时价格查询

```typescript
import { resolvePriceRow } from './core/stats/billing.js';

const evolclawHome = resolvePaths().root;
const priceRow = resolvePriceRow(evolclawHome, 'claude-opus-4-8', Date.now());

if (priceRow) {
  const cost = (inputTokens * priceRow.price_input 
              + outputTokens * priceRow.price_output 
              + cacheReadTokens * priceRow.price_cache_read
              + cacheCreationTokens * priceRow.price_cache_creation) / 1_000_000;
  console.log(`Cost: ${cost.toFixed(4)} ${priceRow.currency}`);
}
```

### 币种处理

- **USD**：直接计算
- **CNY**：需汇率转换（当前未实现，计费模块按需补充）

---

## 网关价格 vs 计费价格

| | 网关价格 | 计费价格 |
|---|---|---|
| **定义** | 网关对外报价（可能含倍率/溢价） | 模型官方原价（成本核算） |
| **来源** | 网关 `/v1/models` 的 `effective_pricing` | 网关 `/v1/models` 的 `pricing` 或本地 jsonl |
| **用途** | ECWeb 展示、用户参考 | usage.db 计费、成本统计 |
| **修改** | 「改价」写用户覆盖层 | 官方调价后更新包基线 |

**当前实现**：两者都走 `model-prices.jsonl` 回退（网关不返 pricing 时）。用户「改价」实际改的是**计费价格**（覆盖官方价），网关价格由网关接口决定。

---

## 扩展：支持新计费算法

当前支持两种：
- `per_token_v1`：通用按 token 计费（input/output/cache_read/cache_creation）
- `per_token_deepseek_v1`：DeepSeek 缓存模型（cache_hit/cache_miss/output）

新增算法步骤：
1. 在 `src/core/stats/billing.ts` 添加计费函数（如 `export function per_token_gemini_v1(...)`）
2. `model-prices.jsonl` 中设 `"billing_fn": "per_token_gemini_v1"`
3. `PriceRecord` 接口追加对应字段（如 `price_thinking?`）

---

## FAQ

### Q1：为什么网关价格和官方价格都显示「—」？

**A**：三级回退都没拿到价格：
1. 网关 `/v1/models` 不返回 `pricing`（如标准 OpenAI 代理）
2. 本地 `model-prices.jsonl` 没有该模型记录
3. 用户未手动设价

**解决**：点「改价」手动填写，或等待包基线更新。

### Q2：我改了价格，为什么 ECWeb 还显示旧价格？

**A**：价格缓存 5 分钟 TTL。重启 daemon 或等 5 分钟。

### Q3：网关返回的 `effective_pricing` 会覆盖我手动改的价格吗？

**A**：不会。三级回退优先级：网关接口 > 本地 jsonl > 手动改价。手动改价写入本地 jsonl（优先级 2），只有网关不返回时才生效。如果希望手动价格优先，需停用网关的 pricing 返回（或改代码跳过接口解析）。

### Q4：`price_cache_creation` 和 `cache_write` 有什么区别？

**A**：同一概念的不同命名：
- `price_cache_creation`：JSONL 存储字段名
- `cache_write`：网关接口 + 前端展示名
- 含义都是"缓存写入单价"（对应 Claude 的 prompt caching creation）

### Q5：DeepSeek 的价格为什么字段不一样？

**A**：DeepSeek 缓存模型用特殊计费算法（`per_token_deepseek_v1`），区分：
- `price_cache_hit`：缓存命中（便宜）
- `price_cache_miss`：缓存未命中（贵）
- `price_output`：输出 token

与通用模型的 `input/output/cache_read/cache_write` 四字段不兼容，需独立处理。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `data/stats/model-prices.jsonl` | 包基线价格表（只读） |
| `$EVOLCLAW_HOME/data/stats/model-prices.jsonl` | 用户覆盖层（可写） |
| `src/core/stats/billing.ts` | 价格查询 + 计费算法 |
| `src/core/message/command-handler-gateway-control.ts` | gatewayModels / gatewaySetPrice |
| `ecweb/src/static/app.js` | 前端价格展示 + 改价弹窗 |

---

## 版本历史

- **v3.4.0**（2026-06-14）：初始价格体系 + 17 个模型基线 + ECWeb 价格展示
