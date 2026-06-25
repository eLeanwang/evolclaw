# Codex Runner 待决策项

**日期**：2026-06-10
**状态**：待决策（决定方向后再实现）
**关联代码**：`src/agents/codex-runner.ts`

---

## 背景

Codex 后端（OpenAI Responses API）接入 EvolClaw 后，有三个能力点的当前行为已定，但目标语义尚未拍板。本文记录待决策项，定方向后再进入实现。

---

## 一、`/perm auto` 的审批路由

**现状**：EvolClaw 本地安全检查先行，Codex app-server 用 `approvalPolicy=never`。

**决策点**：
- 保持当前"本地守护的保守模式"（EvolClaw 自己做安全检查）
- 还是把 auto review 路由到 Codex app-server 的 `approvalsReviewer: auto_review`

**权衡**：本地模式可控性强、行为统一；app-server 模式贴近 Codex 原生能力但放权给上游。

---

## 二、`planApproval` 是否支持

**现状**：`planApproval` 能力为 `false`。

**Codex 能力**：app-server 暴露 plan streaming，但没有 Claude 式的 `ExitPlanMode` 审批机制。

**决策点**：
- 保持 capability `false`（明确不支持）
- 还是在 EvolClaw 层设计一套 plan 审批流，模拟 Claude 的体验

---

## 三、文件回滚（rewind）语义

**现状**：降级的 `git-head` 文件回滚。

**决策点**：
- 保持显式的降级行为（明确告知用户是 git-head 级回滚）
- 还是实现按 turn 从 Codex file diff 精确恢复（需处理冲突）

**权衡**：精确回滚体验好但复杂度高（需跟踪每轮 diff + 冲突处理）；git-head 简单但粒度粗。
