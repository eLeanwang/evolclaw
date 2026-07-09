# 响应模式体系重构 - 文档迁移清单

**创建时间**: 2026-07-08  
**目标**: 将 dual-session-lite 迁移到新的响应模式体系架构

---

## 一、核心变更

### 1.1 概念变更

| 旧概念 | 新概念 | 说明 |
|--------|--------|------|
| `responseMode: 'interactive'` | `responseMode: 'single-session'`<br>`config.chatMode: 'interactive'` | 合并为单会话模式 + 参数 |
| `responseMode: 'proactive'` | `responseMode: 'single-session'`<br>`config.chatMode: 'proactive'` | 合并为单会话模式 + 参数 |
| `responseMode: 'dual-session-lite'` | `responseMode: 'dual-session'` | 改名 |
| `chatMode` (ECK Vars) | `chatMode` (通用参数) | 提升为响应模式的通用参数 |
| `mentionMode` (dual-session 特有) | `mentionMode` (通用参数) | 提升为所有模式的通用参数 |

### 1.2 参数分层

**通用参数**（所有响应模式都支持）：
- `chatMode: 'interactive' | 'proactive'`
- `mentionMode: 'disabled' | 'mention-only'`
- `model: string`

**dual-session 特有参数**：
- `debounceMs`
- `maxWaitMs`
- `maxQueueSize`
- `auxiliaryModel`
- `auxiliaryMaxTokens`
- `mainMaxTokens`
- `interruptEnabled`

---

## 二、文档迁移清单

### 2.1 核心架构文档（需要大幅调整）

#### ✅ RESPONSE-MODE-SYSTEM-ARCHITECTURE.md
- **状态**: 已创建（新文档）
- **内容**: 完整的响应模式体系架构
- **操作**: 无需调整

#### 📝 README.md
- **当前**: 介绍 dual-session-lite 模式
- **需要调整**:
  1. ✏️ 更新标题：`双会话响应模式 - 简化版` → `双会话响应模式`
  2. ✏️ 全文替换：`dual-session-lite` → `dual-session`
  3. ✏️ 增加章节：说明 `chatMode` 和 `mentionMode` 是通用参数
  4. ✏️ 更新配置示例：
     ```json
     // 旧
     {
       "responseMode": "dual-session-lite"
     }
     
     // 新
     {
       "responseMode": "dual-session",
       "config": {
         "chatMode": "proactive",
         "mentionMode": "disabled"
       }
     }
     ```

#### 📝 architecture.md
- **当前**: 双会话模式的架构设计
- **需要调整**:
  1. ✏️ 全文替换：`dual-session-lite` → `dual-session`
  2. ✏️ 增加说明：`chatMode` 参数的处理（V2 引擎需要接收并传递给主会话）
  3. ✏️ 更新组件接口：
     ```typescript
     // V2Engine 构造函数
     constructor(config: {
       chatMode: 'interactive' | 'proactive',  // 新增
       mentionMode?: 'disabled' | 'mention-only',
       // ... 其他配置
     })
     ```

#### 📝 ARCHITECTURE-FINAL.md
- **当前**: 详细的架构设计
- **需要调整**:
  1. ✏️ 全文替换：`dual-session-lite` → `dual-session`
  2. ✏️ 如果有 `responseMode` 相关描述，更新为新的参数体系

---

### 2.2 ECK 集成文档（需要调整）

#### 📝 eck-integration.md
- **当前**: ECK 集成方式
- **需要调整**:
  1. ✏️ 更新 ECK Vars 定义：
     ```typescript
     // 旧
     interface ECKVars {
       responseMode: 'dual-session-lite';
       chatMode: 'proactive';  // 位置混乱
       sessionType: 'auxiliary' | 'main';
     }
     
     // 新
     interface ECKVars {
       responseMode: 'dual-session';
       chatMode: 'interactive' | 'proactive';  // 通用参数
       mentionMode: 'disabled' | 'mention-only';  // 通用参数
       sessionType?: 'auxiliary' | 'main';  // dual-session 特有
     }
     ```
  2. ✏️ 更新 manifest when 条件：
     ```yaml
     # 旧
     when: "responseMode === 'dual-session-lite' && sessionType === 'auxiliary'"
     
     # 新
     when: "responseMode === 'dual-session' && sessionType === 'auxiliary'"
     ```
  3. ✏️ 增加章节：说明 chatMode 和 mentionMode 的 fragment 加载（通用，不限于 dual-session）

---

### 2.3 提示词文档（需要调整）

#### 📝 prompts/auxiliary-base.md
- **当前**: 辅助会话提示词
- **需要调整**:
  1. ✏️ 如果提到 `dual-session-lite`，替换为 `dual-session`
  2. ✏️ 确认是否需要感知 `chatMode`（通常不需要，辅助会话只判断投递，不回复）

#### 📝 prompts/main-base.md
- **当前**: 主会话提示词
- **需要调整**:
  1. ✏️ 如果提到 `dual-session-lite`，替换为 `dual-session`
  2. ✏️ 增加 chatMode 说明（如果需要）：
     ```markdown
     ## 回复方式
     
     根据 chatMode 参数：
     - `interactive`: 直接输出即回复
     - `proactive`: 使用 CLI 命令发送回复
     ```

---

### 2.4 数据结构文档（需要小幅调整）

#### 📝 data-structures.md
- **当前**: 数据结构定义
- **需要调整**:
  1. ✏️ 更新配置接口：
     ```typescript
     // 旧
     interface DualSessionLiteConfig {
       debounceMs?: number;
       // ...
     }
     
     // 新
     interface DualSessionConfig extends CommonResponseModeConfig {
       // 通用参数（继承）
       chatMode: 'interactive' | 'proactive';
       mentionMode?: 'disabled' | 'mention-only';
       model?: string;
       
       // 特有参数
       debounceMs?: number;
       maxWaitMs?: number;
       // ...
     }
     ```

---

### 2.5 消息流程文档（需要小幅调整）

#### 📝 message-flow.md
- **当前**: 消息处理流程
- **需要调整**:
  1. ✏️ 全文替换：`dual-session-lite` → `dual-session`
  2. ✏️ 确认流程图中是否需要增加 `chatMode` 分支点（主会话回复时）

---

### 2.6 实施计划文档（参考性文档，低优先级）

#### 📋 IMPLEMENTATION-PLAN.md
- **状态**: 历史文档
- **建议**: 保留原样，或添加前言说明"本文档为历史设计，当前实现见 RESPONSE-MODE-SYSTEM-ARCHITECTURE.md"

#### 📋 IMPL-PLAN-V2-SUMMARY.md
- **状态**: 历史文档
- **建议**: 同上

#### 📋 ISSUES-SUMMARY.md
- **状态**: 历史问题总结
- **建议**: 保留原样

#### 📋 PLUGIN-SYSTEM-ANALYSIS.md / plugin-analysis.md
- **态**: 插件系统分析
- **建议**: 保留原样

#### 📋 REVIEW*.md / REVISION-SUMMARY.md
- **状态**: 评审和修订历史
- **建议**: 保留原样

---

### 2.7 批次角色一致性文档（无需调整）

#### ✅ batch-role-consistency-update.md
- **状态**: 技术细节文档
- **建议**: 无需调整（不涉及响应模式命名）

---

## 三、迁移优先级

### P0 - 必须立即调整（影响用户理解）

1. ✅ **RESPONSE-MODE-SYSTEM-ARCHITECTURE.md**（已创建）
2. 📝 **README.md**（用户入口）
3. 📝 **eck-integration.md**（集成关键）

### P1 - 应该调整（影响开发者理解）

4. 📝 **architecture.md**
5. 📝 **ARCHITECTURE-FINAL.md**
6. 📝 **data-structures.md**
7. 📝 **message-flow.md**

### P2 - 可选调整（提示词）

8. 📝 **prompts/auxiliary-base.md**
9. 📝 **prompts/main-base.md**

### P3 - 保留原样（历史文档）

10. 📋 **IMPLEMENTATION-PLAN.md**（历史）
11. 📋 **IMPL-PLAN-V2-SUMMARY.md**（历史）
12. 📋 **ISSUES-SUMMARY.md**（历史）
13. 📋 **PLUGIN-SYSTEM-ANALYSIS.md**（分析）
14. 📋 **plugin-analysis.md**（分析）
15. 📋 **REVIEW*.md**（评审）
16. 📋 **REVISION-SUMMARY.md**（修订）
17. ✅ **batch-role-consistency-update.md**（无需调整）

---

## 四、全局搜索替换清单

### 4.1 术语替换

```bash
# 在所有 P0/P1/P2 文档中执行
find docs/response-system/dual-session-lite \
  -name "*.md" \
  -not -name "IMPLEMENTATION-PLAN.md" \
  -not -name "IMPL-PLAN-V2-SUMMARY.md" \
  -not -name "ISSUES-SUMMARY.md" \
  -not -name "PLUGIN-SYSTEM-ANALYSIS.md" \
  -not -name "plugin-analysis.md" \
  -not -name "REVIEW*.md" \
  -not -name "REVISION-SUMMARY.md" \
  -exec sed -i 's/dual-session-lite/dual-session/g' {} \;
```

### 4.2 配置示例替换

**旧格式**:
```json
{
  "responseMode": "dual-session-lite"
}
```

**新格式**:
```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled"
  }
}
```

---

## 五、验证清单

迁移完成后，验证以下内容：

- [ ] 所有 P0/P1 文档中不再出现 `dual-session-lite`（除非在"旧名称"上下文中）
- [ ] 所有配置示例使用新格式（`responseMode: 'dual-session'` + `config`）
- [ ] `chatMode` 和 `mentionMode` 被描述为**通用参数**，不是 dual-session 特有
- [ ] ECK Vars 定义清晰：`responseMode` / `chatMode` / `mentionMode` / `sessionType`
- [ ] 提示词文档中包含 chatMode 的处理说明（如果需要）

---

## 六、后续工作

1. **目录重命名**（可选）：
   ```bash
   mv docs/response-system/dual-session-lite docs/response-system/dual-session
   ```
   
2. **更新其他引用**：
   - 检查 `docs/response-system/` 其他目录下的文档是否引用了 `dual-session-lite`
   - 更新 `docs/response-system/README.md` 和 `docs/response-system/INDEX.md`

3. **代码实现**：
   - 实现响应模式注册表（`src/response-system/registry.ts`）
   - 合并 single-session 模式（移除 interactive/proactive 作为独立模式）
   - V1/V2 引擎支持 `chatMode` 参数
   - 配置迁移工具

---

**状态**: 待执行  
**预计工作量**: 2-3 小时（文档调整）  
**风险**: 低（主要是文档和命名变更）
