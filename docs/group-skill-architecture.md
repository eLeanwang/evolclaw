# 群Skill架构设计（Group Skill Architecture）

> 状态：draft v0.1
> 创建：2026-05-19
> 依赖：`docs/frontend-capability-layer.md`（前端能力）、`docs/session-context-assembly.md`（上下文组装）

## 核心洞察

**设备即能力提供者**：每个接入AUN的设备（手机/桌面/IoT/机器人）都运行一个agent，该agent把设备的软硬件能力封装为**可调用的skill**，暴露给网络中的其他主体。

**群skill = 单聊skill**：
- 单聊（尤其是主人↔agent）本质是"二人群"
- 主人的手机前端 = 一个能力提供者，agent可以调用其skill
- 群聊中，所有成员的能力（经授权）汇聚成**群能力池**，任何成员都可以调用
- 统一模型：venue（无论private/group）都有一个skill registry

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    AUN Network                          │
│                                                         │
│  ┌─────────┐      ┌─────────┐      ┌─────────┐        │
│  │ Alice   │      │ Bob     │      │ Charlie │        │
│  │ (human) │      │ (agent) │      │ (agent) │        │
│  └────┬────┘      └────┬────┘      └────┬────┘        │
│       │                │                │             │
│       │ 提供能力        │ 提供能力        │ 提供能力     │
│       ▼                ▼                ▼             │
│  ┌─────────────────────────────────────────────┐      │
│  │         Venue Skill Registry                │      │
│  │  (群/私聊的共享能力池)                        │      │
│  ├─────────────────────────────────────────────┤      │
│  │ Alice's iPhone:                             │      │
│  │   - camera.capture                          │      │
│  │   - env.location                            │      │
│  │   - contacts.search                         │      │
│  │   - sensor.motion                           │      │
│  │                                             │      │
│  │ Bob (coding agent):                         │      │
│  │   - code.review (skill)                     │      │
│  │   - git.commit (skill)                      │      │
│  │   - test.run (tool)                         │      │
│  │                                             │      │
│  │ Charlie (data agent):                       │      │
│  │   - sql.query (skill)                       │      │
│  │   - chart.generate (skill)                  │      │
│  │   - data.export (tool)                      │      │
│  └─────────────────────────────────────────────┘      │
│                                                         │
│  任何成员都可以调用池中的skill（需授权）                  │
└─────────────────────────────────────────────────────────┘
```

## 能力分类

### Tool（工具）

**定义**：原子操作，同步/短异步（<30s），返回确定结果。

**特征**：
- 输入输出明确
- 无状态（或状态由提供者管理）
- 可组合

**示例**：
- `camera.capture` — 拍照返回图片
- `fs.read` — 读文件返回内容
- `env.location` — 返回当前位置
- `sql.query` — 执行SQL返回结果

### Skill（技能）

**定义**：复杂任务，可能长时异步（分钟级），可能需要多轮交互，返回结构化结果或触发后续动作。

**特征**：
- 内部可能调用多个tool
- 可能有中间状态
- 可能需要回调/通知

**示例**：
- `code.review` — 代码审查（读文件 + 分析 + 生成报告）
- `meeting.schedule` — 安排会议（查日历 + 找空闲 + 发邀请）
- `trip.plan` — 行程规划（查地图 + 订票 + 订酒店）
- `doc.summarize` — 文档总结（读取 + 分析 + 生成摘要）

### 两者关系

```
Skill 内部可以调用 Tool
Tool 是 Skill 的原子单元
Skill 可以组合其他 Skill（递归）
```

## Venue Skill Registry

每个venue（private/group）维护一个skill registry：

```
agents/<self-aid>/venues/<venue-name>/
├── profile.md
├── history.jsonl
└── skills/
    ├── registry.json          ← skill清单
    ├── permissions.json       ← 授权矩阵
    └── invocations.jsonl      ← 调用日志
```

### registry.json 格式

```jsonc
{
  "venue_uid": "v_abc123",
  "updated_at": "2026-05-19T04:30:00Z",
  "providers": [
    {
      "provider_id": "alice.agentid.pub",
      "provider_type": "human",
      "device_type": "mobile",
      "device_id": "iphone_xyz",
      "online": true,
      "capabilities": [
        {
          "id": "camera.capture",
          "type": "tool",
          "category": "media",
          "sync": false,
          "timeout_ms": 30000,
          "require_confirm": true,
          "description": "拍照并返回图片",
          "params": {
            "facing": { "type": "string", "enum": ["front", "back"], "default": "back" },
            "flash": { "type": "string", "enum": ["auto", "on", "off"], "default": "auto" }
          },
          "returns": {
            "type": "image",
            "format": ["jpeg", "png"]
          }
        },
        {
          "id": "env.location",
          "type": "tool",
          "category": "sensor",
          "sync": true,
          "timeout_ms": 5000,
          "require_confirm": false,
          "description": "获取当前语义位置",
          "params": {},
          "returns": {
            "type": "object",
            "fields": {
              "city": "string",
              "district": "string",
              "street": "string",
              "place_type": "string"
            }
          }
        }
      ]
    },
    {
      "provider_id": "bob.agentid.pub",
      "provider_type": "agent",
      "device_type": "server",
      "online": true,
      "capabilities": [
        {
          "id": "code.review",
          "type": "skill",
          "category": "development",
          "sync": false,
          "timeout_ms": 300000,
          "require_confirm": false,
          "description": "代码审查并生成报告",
          "params": {
            "repo_path": { "type": "string", "required": true },
            "files": { "type": "array", "items": "string" },
            "focus": { "type": "string", "enum": ["security", "performance", "style", "all"], "default": "all" }
          },
          "returns": {
            "type": "object",
            "fields": {
              "issues": "array",
              "summary": "string",
              "score": "number"
            }
          }
        }
      ]
    }
  ]
}
```

### permissions.json 格式

```jsonc
{
  "venue_uid": "v_abc123",
  "rules": [
    {
      "invoker": "bob.agentid.pub",          // 谁可以调用
      "target": "alice.agentid.pub",         // 调用谁的能力
      "capabilities": ["camera.*", "env.*"], // 允许调用哪些（支持通配符）
      "granted_by": "alice.agentid.pub",     // 谁授权的
      "granted_at": "2026-05-19T04:00:00Z",
      "expires_at": null,                    // null = 永久
      "conditions": {
        "max_per_hour": 10,                  // 频率限制
        "require_reason": true               // 是否需要说明理由
      }
    },
    {
      "invoker": "*",                        // 所有人
      "target": "bob.agentid.pub",
      "capabilities": ["code.review"],
      "granted_by": "bob.agentid.pub",
      "granted_at": "2026-05-19T04:00:00Z",
      "expires_at": null,
      "conditions": {
        "max_per_day": 50
      }
    }
  ]
}
```

### invocations.jsonl 格式

```jsonc
{"ts":"2026-05-19T04:35:12Z","invoker":"bob.agentid.pub","target":"alice.agentid.pub","capability":"camera.capture","params":{"facing":"back"},"status":"success","duration_ms":2340,"result_size":1024000}
{"ts":"2026-05-19T04:36:45Z","invoker":"charlie.agentid.pub","target":"bob.agentid.pub","capability":"code.review","params":{"repo_path":"/proj"},"status":"pending","request_id":"req_xyz"}
{"ts":"2026-05-19T04:40:12Z","invoker":"charlie.agentid.pub","target":"bob.agentid.pub","capability":"code.review","request_id":"req_xyz","status":"success","duration_ms":207000}
```

## Skill调用流程

### 同步Tool调用（env.location）

```
Charlie (invoker) 想知道 Alice 的位置
    │
    ├─ Step 1: 查询 venue skill registry
    │   检查 Alice 是否在线
    │   检查 Alice 是否提供 env.location
    │   检查 Charlie 是否有权限调用
    │
    ├─ Step 2: 构造 skill_invoke 消息
    │   {
    │     "type": "skill_invoke",
    │     "request_id": "req_abc",
    │     "invoker": "charlie.agentid.pub",
    │     "target": "alice.agentid.pub",
    │     "capability": "env.location",
    │     "params": {},
    │     "reason": "需要了解你的位置以推荐附近餐厅"
    │   }
    │
    ├─ Step 3: 通过 AUN 发送到 Alice 的前端
    │   Alice 前端收到请求
    │   ├─ require_confirm: false → 静默执行
    │   └─ require_confirm: true → 弹窗确认
    │
    ├─ Step 4: Alice 前端执行 env.location
    │   调用 GPS → 反地理编码 → 返回语义位置
    │
    ├─ Step 5: 返回 skill_result 消息
    │   {
    │     "type": "skill_result",
    │     "request_id": "req_abc",
    │     "status": "success",
    │     "result": {
    │       "city": "北京市",
    │       "district": "海淀区",
    │       "street": "中关村大街",
    │       "place_type": "办公区"
    │     },
    │     "duration_ms": 1200
    │   }
    │
    └─ Step 6: Charlie 收到结果，继续对话
        "Alice现在在中关村，推荐你们去..."
```

### 异步Skill调用（code.review）

```
Alice 请求 Bob 做代码审查
    │
    ├─ Step 1-2: 同上（查registry + 构造请求）
    │
    ├─ Step 3: 发送 skill_invoke 到 Bob
    │   Bob 收到请求，返回 skill_ack
    │   {
    │     "type": "skill_ack",
    │     "request_id": "req_xyz",
    │     "status": "accepted",
    │     "estimated_duration_ms": 180000,  // 预计3分钟
    │     "progress_updates": true          // 会发送进度更新
    │   }
    │
    ├─ Step 4: Bob 开始执行（后台）
    │   Alice 可以继续做其他事
    │   Bob 定期发送 skill_progress
    │   {
    │     "type": "skill_progress",
    │     "request_id": "req_xyz",
    │     "progress": 0.6,                  // 60%
    │     "message": "正在分析安全问题..."
    │   }
    │
    ├─ Step 5: Bob 完成，发送 skill_result
    │   {
    │     "type": "skill_result",
    │     "request_id": "req_xyz",
    │     "status": "success",
    │     "result": {
    │       "issues": [...],
    │       "summary": "发现3个安全问题，2个性能问题",
    │       "score": 7.5
    │     },
    │     "duration_ms": 187000
    │   }
    │
    └─ Step 6: Alice 收到结果
        可以在当前对话中展示，或作为新消息通知
```

## 能力发现与注册

### 前端连接时自动注册

```
Alice 的 iPhone 连接到 evolclaw
    │
    ├─ Step 1: 前端发送 capability_report
    │   {
    │     "type": "capability_report",
    │     "device_id": "iphone_xyz",
    │     "device_type": "mobile",
    │     "platform": "ios",
    │     "capabilities": [...]
    │   }
    │
    ├─ Step 2: evolclaw 更新所有 Alice 参与的 venue
    │   遍历 venues/ 下所有包含 Alice 的 venue
    │   更新各 venue 的 skills/registry.json
    │   标记 Alice 为 online
    │
    └─ Step 3: 向 venue 内其他成员广播 skill_registry_updated
        {
          "type": "skill_registry_updated",
          "venue_uid": "v_abc123",
          "provider": "alice.agentid.pub",
          "action": "online",
          "new_capabilities": [...]
        }
```

### Agent Skill注册

Agent自身的skill（如Bob的code.review）在agent启动时注册：

```
agents/<aid>/personal/skills/
├── _index.json               ← agent自身提供的skill清单
└── code-review.md            ← skill详细文档
```

Agent连接AUN时，把`personal/skills/_index.json`中的skill注册到所有参与的venue。

## 授权管理

### 授权流程

```
Bob 想调用 Alice 的 camera.capture，但没有权限
    │
    ├─ Step 1: Bob 发起调用，收到 permission_denied
    │   {
    │     "type": "skill_result",
    │     "request_id": "req_abc",
    │     "status": "permission_denied",
    │     "message": "你没有权限调用 alice.agentid.pub 的 camera.capture"
    │   }
    │
    ├─ Step 2: Bob 请求授权
    │   {
    │     "type": "permission_request",
    │     "request_id": "perm_req_123",
    │     "requester": "bob.agentid.pub",
    │     "target": "alice.agentid.pub",
    │     "capabilities": ["camera.capture"],
    │     "reason": "需要拍照识别这个物体",
    │     "duration": "1h"                // 临时授权1小时
    │   }
    │
    ├─ Step 3: Alice 收到授权请求
    │   前端弹窗：
    │   "Bob 请求调用你的相机拍照，理由：需要拍照识别这个物体。授权1小时？"
    │   [同意] [拒绝] [永久授权]
    │
    ├─ Step 4: Alice 同意
    │   {
    │     "type": "permission_grant",
    │     "request_id": "perm_req_123",
    │     "granted": true,
    │     "expires_at": "2026-05-19T05:35:00Z"
    │   }
    │
    ├─ Step 5: 更新 venue permissions.json
    │   添加新规则
    │
    └─ Step 6: Bob 重新调用 camera.capture
        这次成功
```

### 授权粒度

| 粒度 | 示例 | 说明 |
|---|---|---|
| 单次 | `duration: "once"` | 仅本次调用 |
| 限时 | `duration: "1h"` / `"1d"` | 临时授权 |
| 永久 | `expires_at: null` | 需显式撤销 |
| 通配符 | `capabilities: ["camera.*"]` | 授权整个类别 |
| 条件 | `max_per_hour: 10` | 频率限制 |

## 单聊 = 二人群

私聊场景下，venue_uid = 对端AID，skill registry同样存在：

```
agents/<self-aid>/venues/private_alice/
└── skills/
    ├── registry.json         ← Alice的前端能力 + self的agent能力
    ├── permissions.json      ← 双向授权
    └── invocations.jsonl
```

**对称性**：
- Alice可以调用self的skill（如code.review）
- Self可以调用Alice前端的tool（如camera.capture）
- 授权机制完全一致

**主人↔agent的特殊性**：
- 主人对自己agent的skill调用**默认全部授权**（owner privilege）
- Agent对主人前端的tool调用**仍需授权**（隐私保护）

## 群Skill的威力

### 场景1：多agent协作

```
群成员：Alice (human), Bob (coding agent), Charlie (data agent)

Alice: "帮我分析一下这个项目的代码质量和数据库性能"

Bob 调用自己的 code.review skill → 生成代码报告
Charlie 调用自己的 sql.analyze skill → 生成数据库报告
两者结果汇总后回复 Alice
```

### 场景2：跨设备能力组合

```
群成员：Alice (iPhone), Alice's MacBook (desktop agent)

Alice (在iPhone上): "把我刚拍的照片传到电脑上，然后用Photoshop打开"

iPhone agent 调用 camera.capture → 拍照
iPhone agent 调用 MacBook 的 file.receive → 传输文件
MacBook agent 调用 app.launch("Photoshop") → 打开应用
```

### 场景3：IoT设备编排

```
群成员：Alice (human), 智能音箱 (speaker agent), 扫地机器人 (robot agent), 空调 (ac agent)

Alice: "我快到家了，帮我准备一下"

Speaker agent 调用 Alice iPhone 的 env.location → 确认距离
Robot agent 启动清扫（如果还没扫）
AC agent 提前开启空调
Speaker agent 播放 Alice 喜欢的音乐
```

## 安全与隐私

### 三层防护

| 层 | 机制 | 说明 |
|---|---|---|
| 授权层 | permissions.json | 显式授权才能调用 |
| 确认层 | require_confirm | 敏感操作前端二次确认 |
| 审计层 | invocations.jsonl | 所有调用可追溯 |

### 敏感能力的特殊处理

| 能力类型 | 限制 |
|---|---|
| 通信（打电话/发短信） | 永远require_confirm，不支持批量授权 |
| 支付 | 不暴露为skill，只能用户在前端主动操作 |
| 删除数据 | require_confirm + 需说明理由 |
| 访问通讯录 | 手机号永不上传，只返回姓名 |
| 精确定位 | 只返回语义位置，GPS坐标不出前端 |

### 撤销机制

```
Alice 发现 Bob 调用太频繁，撤销授权
    │
    ├─ Alice 在前端操作："撤销 Bob 对我相机的访问权限"
    │
    ├─ 前端发送 permission_revoke 消息
    │   {
    │     "type": "permission_revoke",
    │     "revoker": "alice.agentid.pub",
    │     "target": "bob.agentid.pub",
    │     "capabilities": ["camera.*"]
    │   }
    │
    ├─ 更新所有相关 venue 的 permissions.json
    │
    └─ Bob 下次调用时收到 permission_denied
```

## 实现路径

### Phase 1：基础设施

1. 定义 skill_invoke / skill_result / skill_ack / skill_progress 消息格式
2. 实现 venue skills/ 目录结构
3. 实现 registry.json / permissions.json 的读写
4. 前端连接时自动注册能力到 registry

### Phase 2：Tool调用（同步）

1. 实现同步tool调用流程（env.location / camera.capture）
2. 实现授权检查 + permission_request / permission_grant
3. 实现 invocations.jsonl 审计日志
4. 前端UI：授权请求弹窗

### Phase 3：Skill调用（异步）

1. 实现异步skill调用 + ack + progress
2. Agent自身skill注册（personal/skills/）
3. Skill组合调用（skill内部调用其他skill/tool）
4. 超时 + 重试 + 错误处理

### Phase 4：高级特性

1. 能力发现UI（查看venue内所有可用skill）
2. 授权管理UI（查看/撤销已授权）
3. 调用统计（频率/成功率/耗时分析）
4. Skill市场（agent可以发布/订阅skill）

## 开放问题

1. **Skill的计费模型**：调用他人的skill是否需要付费？如何定价？

2. **Skill的版本管理**：skill升级后向后兼容如何保证？

3. **跨venue的skill共享**：Alice在群A授权Bob调用相机，Bob在群B能否继续调用？建议：授权绑定venue，不跨venue。

4. **Skill的SLA保证**：异步skill如果长时间不返回怎么办？建议：timeout + 降级策略。

5. **恶意调用防护**：Bob疯狂调用Alice的相机怎么办？建议：频率限制 + 异常检测 + 自动撤销。
