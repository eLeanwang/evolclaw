# EvolClaw 项目状态报告

> 生成日期：2026-04-13  
> 数据来源：git commit 历史（199 commits）、CHANGELOG.md、README.md、docs/ 设计文档

---

## 一、项目概述

EvolClaw 是一个轻量级 AI Agent 网关系统，为 Claude Code / Codex / Gemini / Hermes 等 AI Agent 提供统一接入层，支持飞书、微信、AUN Mesh 网络和终端 TUI 四种通道。人类可以通过手机 IM 随时接力开发，Agent 之间也可以通过 AUN 网络直接协作。

**技术栈**：Node.js >= 22 + TypeScript (ES Modules) + node:sqlite + Vitest

---

## 二、功能模块总览

### 2.1 消息渠道层

| 子模块 | 状态 | 落地版本 | 负责代码 | 说明 |
|--------|------|----------|----------|------|
| 飞书 (WebSocket) | ✅ 已完成 | v2.0.0 | `src/channels/feishu.ts` | WebSocket 推送、@提及提取、表格卡片渲染 |
| 微信 (HTTP 长轮询) | ✅ 已完成 | v2.0.6 | `src/channels/wechat.ts` | ClawBot ilink API、CDN 媒体下载、session 过期自恢复 |
| AUN Mesh 网络 | ✅ 已完成 | v2.2.0 | `src/channels/aun.ts` | Sidecar 架构、自动重连、健康监控 |
| 渠道插件化加载 | ✅ 已完成 | v2.2.0 | `src/core/channel-loader.ts` | ChannelPlugin 接口、动态注册 |
| 多实例渠道支持 | ✅ 已完成 | v2.2+ | `src/core/channel-loader.ts` | 同一渠道类型多实例配置 |

### 2.2 Agent 后端层

| 子模块 | 状态 | 落地版本 | 负责代码 | 说明 |
|--------|------|----------|----------|------|
| Claude (SDK) | ✅ 已完成 | v2.0.0 | `src/agents/claude-runner.ts` | Agent SDK 封装、中断支持、会话恢复 |
| Codex (OpenAI API) | ✅ 已完成 | v2.2.0 | `src/agents/codex-runner.ts` | Responses API、rollout 文件回退 |
| Hermes (Python Bridge) | 🔧 进行中 | — | `src/agents/hermes-runner.ts` + `projects/hermes-bridge/hermes_bridge.py` | stdin/stdout JSON 协议、crash recovery |
| Gemini (CLI subprocess) | ✅ 基础完成 | v2.2+ | `src/agents/gemini-runner.ts` | CLI 子进程、JSONL 事件解析、会话恢复 |
| Gemini SDK 原生接入 | 📋 待开发 | — | 设计文档: `docs/gemini-sdk-integration-plan.md` | @google/genai 替代 CLI 调用 |

### 2.3 消息处理层

| 子模块 | 状态 | 落地版本 | 负责代码 |
|--------|------|----------|----------|
| 统一事件处理引擎 | ✅ 已完成 | v2.0.0 | `src/core/message/message-processor.ts` |
| 消息队列 + 中断 | ✅ 已完成 | v2.0.0 | `src/core/message/message-queue.ts` |
| StreamFlusher 批量发送 | ✅ 已完成 | v2.0.0 | `src/core/message/stream-flusher.ts` |
| 消息撤回 + FIFO 合并 | ✅ 已完成 | v2.2.0 | `src/core/message/message-queue.ts` |
| 输入防抖 | ✅ 已完成 | v2.0.0 | `src/core/message/stream-debouncer.ts` |

### 2.4 会话管理层

| 子模块 | 状态 | 落地版本 | 负责代码 |
|--------|------|----------|----------|
| 多项目会话管理 | ✅ 已完成 | v2.0.0 | `src/core/session/session-manager.ts` |
| 多会话命名切换 | ✅ 已完成 | v2.1.0 | `/new /slist /s /name /del` |
| 飞书话题独立会话 | ✅ 已完成 | v2.1.0 | thread_id 隔离、并行队列 |
| 会话持久化 + 恢复 | ✅ 已完成 | v2.0.0 | SQLite + JSONL 共享 |
| 会话文件适配器 | ✅ 已完成 | v2.2+ | `src/core/session/adapters/` (claude/codex/gemini/hermes) |

### 2.5 权限与安全

| 子模块 | 状态 | 落地版本 | 说明 |
|--------|------|----------|------|
| 分层权限 (user/admin) | ✅ 已完成 | v2.0.6 | `src/core/permission.ts` |
| 交互式授权 (文本) | ✅ 已完成 | v2.2.0 | 文本回复 Y/N |
| 交互式授权 (飞书卡片) | 📋 待开发 | — | Message Card 审批界面 |
| 自动授权可配置 | 📋 待开发 | — | 按规则自动放行/拒绝 |
| SSRF 防护 | ✅ 已完成 | v2.0.6 | `src/utils/media-cache.ts` |

### 2.6 CLI 工具链

| 子模块 | 状态 | 落地版本 | 说明 |
|--------|------|----------|------|
| 服务管理 (start/stop/restart/status/logs) | ✅ 已完成 | v2.0.0 | `src/cli.ts` |
| 交互式初始化 (init feishu/wechat/aun) | ✅ 已完成 | v2.0.0 | `src/utils/init.ts` + `init-channel.ts` |
| TUI 终端客户端 | ✅ 已完成 | v2.2.0 | `aun/aun_cli.py` |
| 项目搬家 (mv) | ✅ 已完成 | v2.2.0 | 保留全部会话历史 |
| 自愈机制 (self-heal) | ✅ 已完成 | v2.0.0 | 重启失败自动诊断修复 |
| 环境诊断 (diagnose) | ✅ 已完成 | v2.2.0 | 启动环境检查 |

### 2.7 运维与监控

| 子模块 | 状态 | 落地版本 | 说明 |
|--------|------|----------|------|
| IPC 状态服务器 | ✅ 已完成 | v2.2.0 | Unix socket、CLI 查询 |
| /check 健康面板 | ✅ 已完成 | v2.2.0 | 配置完整性、统计数据 |
| 代码行数统计 | ✅ 已完成 | v2.0.0 | 按模块分类、历史记录 |
| 空闲超时 + 安全模式 | ✅ 已完成 | v2.0.0 | 分级响应、自动修复 |

---

## 三、版本发布历史

| 版本 | 发布日期 | 里程碑 | 变更量 | 核心内容 |
|------|----------|--------|--------|----------|
| **v2.0.0** | 2026-03-18 | 架构重生 | — | CLI 替代 shell 脚本、node:sqlite、数据目录解耦、统一消息处理 |
| **v2.0.6** | 2026-03-26 | 跨平台 | 18 files, +1001/-174 | Windows 全兼容、微信 CDN 媒体、Feishu @提及 |
| **v2.0.7** | 2026-03-26 | 补丁 | — | 会话轮数统计修正、Windows 路径编码 |
| **v2.1.0** | 2026-03-27 | 话题会话 | 31 files, +1973/-411 | 飞书 thread 独立会话、DB schema 升级、/stop 优化 |
| **v2.1.1** | 2026-03-30 | 模型控制 | — | /model effort 推理强度、/del 命令、/fork thread 支持 |
| **v2.2.0** | 2026-04-09 | 多 Agent | — | Claude+Codex 双后端、AUN 通道、富内容渲染、/check 面板 |
| *未发版* | 2026-04-12 | 四后端 | ~80 files | +Gemini +Hermes、目录结构重组、多实例渠道 |

---

## 四、开发计划

### P0 — 近期（1-2 周）

| ID | 任务 | 类型 | 前置条件 | 优先级 | 说明 |
|----|------|------|----------|--------|------|
| P0-1 | Hermes 后端优化 | 功能完善 | 核心已就位 | 高 | 工具边界分割优化、会话上下文增强、crash recovery 完善和测试覆盖 |
| P0-2 | v2.3.0 发版 | 发布 | P0-1 完成 | 高 | 合入四后端 + 目录重组 + 多实例渠道，更新 CHANGELOG 和 README |
| P0-3 | 交互式卡片授权 | 新功能 | 设计已完成 | 高 | 飞书 Message Card 替代文本 Y/N，按钮式审批，提升操作体验 |

### P1 — 中期（2-4 周）

| ID | 任务 | 类型 | 前置条件 | 优先级 | 说明 |
|----|------|------|----------|--------|------|
| P1-1 | Gemini SDK 原生接入 | 重构 | 设计文档已就绪 | 中 | `@google/genai` 替代 CLI subprocess，改善多轮对话和流式控制 |
| P1-2 | 自动授权可配置 | 新功能 | 权限层已就位 | 中 | 按工具类型/文件路径规则自动放行或拒绝，减少人工干预频率 |
| P1-3 | 微信图片/文件发送 | 功能完善 | CDN 下载已就位 | 中 | 补齐微信端文件/图片上传能力（目前仅支持文本发送） |

### P2 — 远期（1-2 月）

| ID | 任务 | 类型 | 优先级 | 说明 |
|----|------|------|--------|------|
| P2-1 | ACP 协议支持 | 新功能 | 低 | 标准化 Agent 间通信协议，实现 Codex / Gemini CLI 原生 Agent 调用 |
| P2-2 | 多租户隔离 | 架构 | 低 | 支持多个独立用户各自拥有 Agent 实例，完整隔离数据和会话 |
| P2-3 | 监控仪表盘 | 运维 | 低 | 会话数、消息量、Agent 响应延迟、错误率等指标可视化 |

---

## 五、技术设计文档清单

| # | 文档 | 路径 | 实现状态 | 落地版本 |
|---|------|------|----------|----------|
| 1 | 微信集成方案 | `docs/wechat-integration-plan.md` | ✅ 已实现 | v2.0.6 |
| 2 | 三层架构重构 | `docs/three-layer-refactor-plan.md` | ✅ 已实现 | v2.2.0 |
| 3 | 渠道插件化设计 | `docs/channel-plugin-design.md` | ✅ 已实现 | v2.2.0 |
| 4 | 权限体系重设计 | `docs/permission-redesign.md` | ✅ 已实现 | v2.2.0 |
| 5 | 事件驱动出站 | `docs/event-driven-outbound-plan.md` | ✅ 已实现 | v2.2.0 |
| 6 | 系统重构总方案 | `docs/evolclaw-refactor-plan.md` | ✅ 已实现 | v2.2.0 |
| 7 | 交互卡片设计 | `docs/interaction-card-design.md` | ⬜ 待实现 | — |
| 8 | Hermes 集成路线 | `docs/hermes-integration-roadmap.md` | 🔧 进行中 | — |
| 9 | Gemini SDK 迁移 | `docs/gemini-sdk-integration-plan.md` | ⬜ 待实现 | — |

---

## 六、开发节奏统计

| 指标 | 数值 |
|------|------|
| 项目启动 | 2026-03-10 |
| 统计截止 | 2026-04-13 |
| 项目周期 | 35 天 |
| 总 commit 数 | 199 |
| 日均 commit | ~5.7 |
| 版本发布数 | 6 个 (v2.0.0 ~ v2.2.0) |
| 周均发版 | ~1.2 |
| 测试覆盖 | 45 文件、~585 测试用例 |

### 高密度开发期

| 时间段 | 主题 | commit 数 |
|--------|------|-----------|
| 3/10 - 3/11 | 项目初始化、核心架构搭建 | ~30 |
| 3/17 - 3/19 | 权限体系、CLI 工具链、自愈机制 | ~25 |
| 3/23 | 微信渠道集成 | ~10 |
| 4/3 - 4/5 | 多 Agent 后端、消息撤回、处理状态 | ~20 |
| 4/9 - 4/12 | Gemini/Hermes 后端、目录重组 | ~15 |

---

## 七、依赖与对齐事项

以下事项可能影响其他团队的开发计划：

1. **ACP 协议（P2-1）**：如果其他团队有 Agent 间互调需求，需要等 ACP 协议落地后才能通过标准协议接入
2. **Gemini SDK 迁移（P1-1）**：迁移期间 Gemini 后端可能有短暂不稳定，使用 Gemini 的工作流需注意
3. **飞书卡片授权（P0-3）**：落地后会改变用户审批交互方式，相关操作文档需同步更新
4. **v2.3.0 发版（P0-2）**：目录结构已大幅调整，依赖 EvolClaw 内部模块路径的下游项目需要同步更新 import 路径

---

*本报告由 EvolClaw 项目 git 历史和文档自动分析生成，建议每周更新一次。*
