# 双会话响应模式 - 实施计划

**版本**: 2.0  
**创建时间**: 2026-07-08  
**状态**: 完整

---

## 一、概述

本文档描述双会话响应模式的分阶段实施计划。

---

## 二、整体路线图

```
Phase 1: 基础架构（2周）
  ↓
Phase 2: 核心功能（3周）
  ↓
Phase 3: 优化与调优（2周）
  ↓
Phase 4: 监控与运维（1周）
```

**总工期**：8周

---

## 三、Phase 1：基础架构（2周）

### 目标

搭建响应模式体系的基础架构，支持模式注册和路由。

### 任务清单

#### Task 1.1：响应模式注册表（3天）

**实现**：`src/response-system/registry.ts`

```typescript
export const responseModeRegistry: Record<string, ResponseModeDescriptor> = {
  'single-session': {
    name: 'single-session',
    displayName: '单会话模式',
    description: '直接响应，无辅助会话',
    factory: (config: SingleSessionConfig) => new SingleSession(config),
    configSchema: singleSessionConfigSchema,
    supportedCommonParams: ['chatMode', 'mentionMode', 'model'],
    specificParams: [],
  },
  
  'dual-session': {
    name: 'dual-session',
    displayName: '双会话模式',
    description: '辅助会话判断，主会话处理',
    factory: (config: DualSessionConfig) => new DualSession(config),
    configSchema: dualSessionConfigSchema,
    supportedCommonParams: ['chatMode', 'mentionMode', 'model'],
    specificParams: [
      'debounceMs',
      'maxWaitMs',
      'maxQueueSize',
      'auxiliaryModel',
      'auxiliaryMaxTokens',
      'mainMaxTokens',
      'interruptEnabled',
    ],
  },
};
```

**测试**：
- [ ] 注册表加载成功
- [ ] 可以根据 name 查找模式
- [ ] configSchema 验证正确

---

#### Task 1.2：配置解析和迁移（3天）

**实现**：`src/response-system/config-parser.ts`

```typescript
// 解析配置
export function parseConfig(rawConfig: any): ResponseModeConfig {
  // 自动迁移旧配置
  const migrated = migrateConfig(rawConfig);
  
  // 验证配置
  const mode = responseModeRegistry[migrated.responseMode];
  if (!mode) {
    throw new Error(`Unknown response mode: ${migrated.responseMode}`);
  }
  
  // 验证 schema
  validateSchema(migrated.config, mode.configSchema);
  
  return migrated;
}

// 迁移旧配置
function migrateConfig(oldConfig: any): ResponseModeConfig {
  if (oldConfig.responseMode === 'interactive') {
    return {
      responseMode: 'single-session',
      config: {
        chatMode: 'interactive',
      },
    };
  }
  
  if (oldConfig.responseMode === 'proactive') {
    return {
      responseMode: 'single-session',
      config: {
        chatMode: 'proactive',
      },
    };
  }
  
  if (oldConfig.responseMode === 'dual-session-lite') {
    return {
      responseMode: 'dual-session',
      config: {
        chatMode: 'proactive',
        mentionMode: 'disabled',
        ...oldConfig.config,
      },
    };
  }
  
  return oldConfig;
}
```

**测试**：
- [ ] 旧配置自动迁移
- [ ] 新配置解析正确
- [ ] schema 验证生效

---

#### Task 1.3：ECK 集成（4天）

**实现**：
1. 更新 `buildECKVars()` 提取通用参数
2. 更新 `manifest.yml` 添加新 sections
3. 实现 sessionType 注入

**测试**：
- [ ] ECK Vars 包含 responseMode / chatMode / mentionMode
- [ ] manifest 条件求值正确
- [ ] 调试输出正确（`eck-debug/vars.json`）

---

### 交付物

- [ ] 响应模式注册表实现
- [ ] 配置解析和迁移工具
- [ ] ECK 集成完成
- [ ] 单元测试通过
- [ ] 文档更新（实施日志）

---

## 四、Phase 2：核心功能（3周）

### 目标

实现双会话响应模式的核心组件和流程。

### Task 2.1：辅助队列（3天）

**实现**：`src/response-system/engines/v2/auxiliary-queue.ts`

**核心功能**：
- 消息入队
- 防抖触发
- 最早消息超时
- 队列满强制投递
- 消息状态管理（PENDING / HOLD / DELAY）

**测试**：
- [ ] 消息入队成功
- [ ] 防抖触发正确
- [ ] 超时触发正确
- [ ] 队列满强制投递
- [ ] 状态更新正确

---

### Task 2.2：辅助会话（4天）

**实现**：`src/response-system/engines/v2/auxiliary-session.ts`

**核心功能**：
- 会话生命周期管理
- 调用辅助模型（DeepSeek / Haiku）
- 解析决策输出（hold / delay / transfer）
- 执行决策（更新队列状态 / 投递主队列）
- 处理主会话反馈

**测试**：
- [ ] 会话创建成功
- [ ] 模型调用成功
- [ ] 决策解析正确
- [ ] 决策执行正确
- [ ] 反馈处理正确

---

### Task 2.3：主队列（2天）

**实现**：`src/response-system/engines/v2/main-queue.ts`

**核心功能**：
- 消息追加
- 批次提取（最多50条）
- 打断机制
- 批次角色一致性（群聊）

**测试**：
- [ ] 消息追加成功
- [ ] 批次提取正确
- [ ] 打断机制工作
- [ ] 角色一致性检查

---

### Task 2.4：主会话（4天）

**实现**：`src/response-system/engines/v2/main-session.ts`

**核心功能**：
- 会话生命周期管理
- 批量处理消息
- 根据 chatMode 回复
- 生成处理总结
- 反馈给辅助会话

**测试**：
- [ ] 会话创建成功
- [ ] 批量处理正确
- [ ] chatMode 处理正确（interactive / proactive）
- [ ] 总结生成正确
- [ ] 反馈发送成功

---

### Task 2.5：V2 引擎集成（2天）

**实现**：`src/response-system/engines/v2/engine.ts`

**核心功能**：
- 统一协调辅助队列 / 辅助会话 / 主队列 / 主会话
- 消息流转
- 错误处理

**测试**：
- [ ] 端到端消息流程
- [ ] 错误处理正确
- [ ] 性能指标达标

---

### 交付物

- [ ] 辅助队列实现
- [ ] 辅助会话实现
- [ ] 主队列实现
- [ ] 主会话实现
- [ ] V2 引擎实现
- [ ] 集成测试通过
- [ ] 性能测试通过

---

## 五、Phase 3：优化与调优（2周）

### 目标

优化性能、调优参数、完善错误处理。

### Task 3.1：延迟投递优化（2天）

**功能**：
- 实现延迟公式：`baseDelayMs + random(0, baseLevelMs(delayLevel) × 对端系数)`（单聊/群聊相同）
- 实现对端系数判定（含 agent→×1.0，全是人→×0.5）
- 实现延迟到期扫描（triggerDelayExpired）与期间新消息重判

**测试**：
- [ ] 延迟公式正确（单聊、群聊都带随机）
- [ ] 对端系数判定正确（人 ×0.5 / agent ×1.0）
- [ ] 延迟到期转投、期间新消息重判正确

---

### Task 3.2：打断机制优化（2天）

**功能**：
- 实现硬打断（调用 SDK abort）
- 实现打断信息注入
- 优化打断策略

**测试**：
- [ ] 硬打断生效
- [ ] 打断信息正确注入
- [ ] 副作用无法撤回（符合预期）

---

### Task 3.3：会话压缩（3天）

**功能**：
- 辅助会话压缩（40k tokens）
- 主会话压缩（160k tokens）
- 压缩摘要生成

**测试**：
- [ ] 压缩触发正确
- [ ] 摘要生成正确
- [ ] 新会话载入正确

---

### Task 3.4：错误处理与降级（3天）

**功能**：
- 辅助会话失败降级
- 主会话失败重试
- HOLD 超时投递

**测试**：
- [ ] 辅助会话失败降级正确
- [ ] 主会话失败重试正确
- [ ] HOLD 超时投递正确

---

### Task 3.5：mentionMode 集成（2天）

**功能**：
- 实现 mention-only 模式（详见 MENTION-MODE-MECHANISM.md）
- 实现 isMentioned 标记
- 实现活跃发言人跟随机制
- 实现引用消息提取和系统提示词渲染

**测试**：
- [ ] mention-only 过滤正确
- [ ] 被 @ 消息立即触发处理
- [ ] 活跃发言人后续消息走正常流程
- [ ] 引用消息正确提取（最多20条/24小时内）
- [ ] 系统提示词包含引用消息警告

---

### 交付物

- [ ] 延迟投递优化
- [ ] 打断机制优化
- [ ] 会话压缩实现
- [ ] 错误处理完善
- [ ] mentionMode 实现
- [ ] 性能优化完成

---

## 六、Phase 4：监控与运维（1周）

### 目标

建立监控体系，提供调试工具，编写运维文档。

### Task 4.1：监控指标（2天）

**指标**：
- 辅助会话过滤率
- 平均响应延迟
- 打断率
- 队列满触发率
- 辅助会话成本占比

**实现**：
- 指标采集
- 指标上报
- 指标可视化

---

### Task 4.2：调试工具（2天）

**工具**：
- ECK 调试输出（vars / context / fragments）
- 消息流程追踪
- 性能分析

**实现**：
- 调试日志
- 调试命令
- 调试面板

---

### Task 4.3：运维文档（2天）

**文档**：
- 常见问题排查
- 性能调优指南
- 故障恢复流程

---

### 交付物

- [ ] 监控指标采集
- [ ] 调试工具完善
- [ ] 运维文档完成
- [ ] 运维培训完成

---

## 七、里程碑

| 里程碑 | 时间 | 交付物 |
|--------|------|--------|
| **M1: 基础架构** | 第2周末 | 注册表 + 配置解析 + ECK 集成 |
| **M2: 核心功能** | 第5周末 | 辅助队列/会话 + 主队列/会话 + V2 引擎 |
| **M3: 优化调优** | 第7周末 | 延迟投递 + 打断 + 压缩 + 错误处理 + mentionMode |
| **M4: 监控运维** | 第8周末 | 监控 + 调试工具 + 运维文档 |

---

## 八、团队分工

### 后端开发（2人）

- **开发 A**：响应模式体系（注册表 / 配置 / ECK）
- **开发 B**：V2 引擎（辅助队列/会话 + 主队列/会话）

### 测试（1人）

- 单元测试
- 集成测试
- 性能测试

### 文档（1人）

- 用户文档维护
- 运维文档编写
- API 文档生成

---

## 九、风险与应对

### 风险 1：辅助模型质量不足

**描述**：DeepSeek 判断准确率低于预期

**应对**：
- 切换到 Claude Haiku
- 优化提示词
- 增加训练示例

### 风险 2：打断机制不稳定

**描述**：硬打断导致副作用问题

**应对**：
- 限制打断使用场景
- 增加打断前确认
- 记录打断日志

### 风险 3：性能不达标

**描述**：响应延迟过高

**应对**：
- 优化队列触发机制
- 减少防抖时间
- 并行处理

---

## 十、验收标准

### 功能验收

- [ ] 所有核心功能实现
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试通过
- [ ] 端到端测试通过

### 性能验收

- [ ] 平均响应延迟 < 15秒
- [ ] 辅助会话过滤率 30-50%
- [ ] 误判率 < 5%
- [ ] 系统稳定性 > 99.9%

### 文档验收

- [ ] 用户文档完整
- [ ] API 文档完整
- [ ] 运维文档完整
- [ ] 代码注释充分

---

## 十一、后续计划

### Phase 5：新响应模式（未来）

- 实现 workflow 响应模式
- 实现 selective-response 模式
- 扩展通用参数体系

### Phase 6：高级功能（未来）

- 多 agent 协作调度
- 智能批次合并
- 自适应参数调优

---

**实施愉快！如有问题，及时沟通。** 🚀
