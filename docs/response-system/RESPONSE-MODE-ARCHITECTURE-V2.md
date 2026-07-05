# EvolClaw 响应模式架构设计 V2

**文档版本**: 2.0  
**创建时间**: 2026-07-04  
**状态**: 架构定稿

---

## 一、架构概述

### 1.1 核心概念

**响应模式（Response Mode）**：Agent 针对某个对端的消息处理策略  
**响应引擎（Response Engine）**：响应模式的技术实现基础

### 1.2 三层架构

```
┌─────────────────────────────────────────┐
│         用户配置层 (User Config)         │
│   Agent 选择响应模式：interactive/      │
│   proactive/dual-session-lite           │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│      响应模式层 (Response Modes)         │
│   用户可见的响应模式插件实现              │
├─────────────────────────────────────────┤
│ • interactive (基于 V1 引擎)            │
│ • proactive (基于 V1 引擎)              │
│ • dual-session-lite (基于 V2 引擎)      │
│ • 未来的模式... (基于 V1/V2/V3)         │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│     响应引擎层 (Response Engines)        │
│   响应模式的技术实现基础                  │
├─────────────────────────────────────────┤
│ • V1 引擎 (暴露接口，支持多模式)         │
│ • V2 引擎 (不暴露接口，完整实现)         │
│ • 未来的引擎... (可暴露或不暴露接口)     │
└─────────────────────────────────────────┘
```

---

## 二、设计原则

### 2.1 用户只选择响应模式

**用户配置**：
```json
{
  "response_mode": "dual-session-lite"
}
```

**用户无需关心**：
- ❌ 什么是"响应引擎"
- ❌ 该模式使用哪个引擎
- ❌ 引擎的内部实现

**系统自动决定**：
- ✅ `dual-session-lite` → 使用 V2 引擎
- ✅ `proactive` → 使用 V1 引擎

---

### 2.2 响应模式决定引擎

| 响应模式 | 使用的引擎 | 绑定关系 |
|----------|-----------|---------|
| `interactive` | V1 引擎 | 固定绑定 |
| `proactive` | V1 引擎 | 固定绑定 |
| `dual-session-lite` | V2 引擎 | 固定绑定 |

**一个响应模式只对应一个引擎**（不可动态切换）

---

### 2.3 引擎接口的动态演进

#### 原则：先实现，后提取接口

**阶段 1：初期实现（不暴露接口）**
```typescript
// 新引擎完整实现，快速迭代
export class V3Engine {
  async processInbound(message) {
    // 完整实现
  }
}
```

**阶段 2：发现复用价值（提取接口）**
```typescript
// 提取接口，支持多个响应模式
export interface V3ResponseMode {
  handleMessage(message): Promise<void>;
}

export class V3Engine implements V3ResponseMode { }
```

**阶段 3：接口演进（根据需要调整）**
```typescript
// 接口随需求演进
export interface V3ResponseMode {
  handleMessage(message, context): Promise<void>;  // 调整签名
  handleBatch?(messages): Promise<void>;           // 新增能力
}
```

#### 影响范围

```
V1 引擎接口调整
  ↓ 影响
├── modes/interactive/       同步更新
├── modes/proactive/         同步更新
└── modes/proactive-plus/    同步更新

V2 引擎内部调整
  ↓ 影响
└── modes/dual-session-lite/ 根据封装程度决定

V1 和 V2 完全隔离
  ↓
V1 调整不影响 V2，V2 调整不影响 V1
```

---

### 2.4 实现新响应模式的决策流程

```
需求：实现新响应模式 X
  ↓
判断：现有引擎能否支持？
  │
  ├─ 能 → 基于现有引擎实现
  │      ├─ 接口够用 → 直接实现
  │      └─ 接口不够 → 扩展引擎接口 + 更新已有模式
  │
  └─ 不能 → 实现新引擎
         ├─ 初期：完整实现（不暴露接口）
         ├─ 中期：发现复用价值 → 提取接口
         └─ 长期：接口随需求演进
```

---

## 三、目录结构

```
src/response-system/
│
├── engines/                           # 响应引擎层（技术实现）
│   │
│   ├── v1/                           # V1 引擎（暴露接口）
│   │   ├── types.ts                 # V1ResponseMode 接口定义
│   │   ├── engine.ts                # V1 引擎核心实现
│   │   ├── context.ts               # V1 上下文构建器
│   │   ├── coordinator.ts           # V1 协调器
│   │   ├── registry.ts              # V1 内部注册表
│   │   └── README.md                # V1 引擎文档
│   │
│   ├── v2/                           # V2 引擎（不暴露接口）
│   │   ├── engine.ts                # V2 引擎完整实现
│   │   ├── auxiliary-queue.ts       # 辅助队列
│   │   ├── auxiliary-session.ts     # 辅助会话
│   │   ├── main-queue.ts            # 主队列
│   │   ├── main-session.ts          # 主会话
│   │   ├── types.ts                 # 内部类型（不对外）
│   │   └── README.md                # V2 引擎文档
│   │
│   └── v3/                           # 未来的引擎（示例）
│       ├── engine.ts
│       └── ...
│
├── modes/                            # 响应模式层（用户可见）
│   │
│   ├── interactive/                 # 交互模式（基于 V1）
│   │   ├── index.ts                # 实现 V1ResponseMode 接口
│   │   └── config-schema.json      # 配置 Schema
│   │
│   ├── proactive/                   # 主动模式（基于 V1）
│   │   ├── index.ts                # 实现 V1ResponseMode 接口
│   │   └── config-schema.json
│   │
│   ├── dual-session-lite/           # 双会话模式（基于 V2）
│   │   ├── index.ts                # 薄包装，直接使用 V2Engine
│   │   └── config-schema.json
│   │
│   └── selective-response/          # 未来的模式（示例）
│       ├── index.ts
│       └── config-schema.json
│
├── registry.ts                       # 响应模式注册表（统一）
├── selector.ts                       # 响应模式选择器
├── types.ts                          # 公共类型定义
├── index.ts                          # 公共 API 导出
└── README.md                         # 响应系统总览文档
```

---

## 四、设计优势

### 4.1 清晰的层次

- **用户层**：只需要知道响应模式
- **模式层**：可见的插件实现
- **引擎层**：技术实现基础

### 4.2 灵活的演进

- ✅ 引擎接口可以随时调整
- ✅ 先实现功能，后提取接口
- ✅ 接口随需求自然演进

### 4.3 明确的影响范围

- ✅ 引擎调整只影响基于该引擎的模式
- ✅ 不同引擎完全隔离
- ✅ 响应模式是稳定的用户接口

### 4.4 降低决策成本

- ✅ 实现新引擎时无需纠结接口设计
- ✅ 先把功能做出来，后续按需调整
- ✅ 接口演进是自然的、渐进的过程

---

## 五、总结

### 核心理念

1. **用户视角**：选择响应模式（如 `dual-session-lite`）
2. **实现视角**：每个响应模式基于某个引擎实现
3. **引擎定位**：技术实现手段，可暴露或不暴露接口
4. **接口演进**：先实现后提取，随需求自然演进

### 设计原则

- ✅ **用户只选择响应模式**（无需关心引擎）
- ✅ **响应模式决定引擎**（固定绑定）
- ✅ **引擎接口动态演进**（先实现后提取）
- ✅ **明确的影响范围**（不同引擎完全隔离）

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-04  
**状态**: ✅ 架构定稿

完整的架构详细设计、接口定义、实现示例、配置方式、扩展性设计请参考：
- `docs/response-system/dual-session-lite/ARCHITECTURE-FINAL.md`
