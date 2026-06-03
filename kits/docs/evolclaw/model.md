# ec model — 模型管理命令集

按作用域查看/设置 agent 使用的模型与推理强度。触发词：切模型/列模型/看当前模型/改强度/模型详情/检查可用模型/诊断网关。

> 与 `ec ctl model`（会话内即时切当前会话模型）不同：`ec model` 改的是**持久化作用域配置**，
> 影响对应范围所有会话的下一条消息；`ec ctl` 只作用于当前运行中的会话。

## 命令

```bash
# 列出可用模型，标注各作用域命中
ec model list

# 显示按优先级解析后实际生效的模型 + 来源
ec model current [--self <aid>] [--peer <X>]

# 查看单个模型详情（厂商/上下文/价格/模态/effort/状态）
ec model info <model-id>

# 设置模型（作用域由 --self/--peer 决定）
ec model use <model-id> [--self <aid>] [--peer <X>] [--effort <level>]

# 清除指定作用域设置，回落上一级
ec model reset [--self <aid>] [--peer <X>]

# 设置推理强度（low|medium|high|xhigh|max|auto）
ec model effort <level> [--self <aid>] [--peer <X>]

# 诊断网关连通性与模型可用性（分阶段输出）
# 阶段1: 网关 DNS/TCP 连通性
# 阶段2: 认证 + 模型列表获取（v1/models → models → remote → mock 降级）
# 阶段3: 当前配置模型确认
# 阶段4: 模型可用性探测（弱并发 → 4并发，约 10s 内完成）
ec model check [--self <aid>] [--peer <X>]
```

## 作用域（越具体越优先：关系 > agent > 全局）

| 参数 | 作用域 | 落盘 |
|------|--------|------|
| （无） | 全局默认 | `defaults.json` |
| `--self <aid>` | agent 级 | `config.json` |
| `--self <aid> --peer <X>` | 关系级 | `relations/<peerKey>/preferences.json` |

`--peer` 取 `channelType#channelId` 或裸 aid（裸 aid 视为 `aun#<aid>`）。改某作用域后，对应范围所有会话的下一条消息即时生效。

## 通用约定

- `--format json` — 所有子命令通用
- 本命令不连 AUN 网络，操作本地配置；与对话内 slash（/model /effort）互不影响
- `check` 子命令例外：会连接网关发探测请求，未配置自定义 baseUrl 时跳过 API 探测
