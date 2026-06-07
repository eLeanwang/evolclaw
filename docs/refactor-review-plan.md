# EvolClaw 重构方案审查计划

## 审查目标

对 `evolclaw-refactor-plan.md` 进行三维度全面审查：
1. **代码规范审查** - TypeScript 规范、接口设计、类型安全
2. **架构契合度审查** - 三层分离、依赖倒置、接口边界
3. **实现逻辑审查** - 实现方案与设计目标的一致性

## 审查团队分工

### Team A: 代码规范审查组
**职责**: 审查代码风格、TypeScript 最佳实践、类型安全

**审查范围**:
- 接口定义 (ChannelAdapter, AgentRunnerInterface, 能力接口)
- 类型定义 (AgentEvent, GatewayEvent, ReplyContext)
- 新模块代码质量 (registry.ts, event-bus.ts, permission.ts)

**审查标准**:
- TypeScript strict mode 兼容性
- 接口命名规范 (Interface 后缀使用)
- 类型安全 (避免 any, 正确使用泛型)
- 代码复用性和可维护性
- 注释和文档完整性

### Team B: 架构设计审查组
**职责**: 审查架构设计与改造目标的契合度

**审查范围**:
- 三层职责划分 (Channel, Gateway, Agent Runner)
- 依赖倒置原则实施
- 接口边界清晰度
- 模块独立性和可组合性

**审查标准**:
- 单一职责原则 (SRP)
- 开闭原则 (OCP)
- 依赖倒置原则 (DIP)
- 最小知识原则
- 层间耦合度

### Team C: 实现逻辑审查组
**职责**: 审查实现方案的正确性和完整性

**审查范围**:
- Channel 层改造 (isGroupChat, 群聊解散处理)
- Gateway 层增强 (EventBus, PermissionGateway, 消息去重)
- Agent Runner 标准化 (AgentEvent, 能力接口)
- 关键设计决策实施

**审查标准**:
- 功能完整性
- 边界条件处理
- 错误处理机制
- 性能影响
- 向后兼容性

## 审查检查清单

### A. 代码规范审查清单

#### A1. 接口设计规范
- [ ] ChannelAdapter 接口方法签名是否符合 TypeScript 规范
- [ ] 可选方法使用 `?:` 标记是否正确
- [ ] ReplyContext 的 metadata 类型定义是否足够灵活
- [ ] AgentRunnerInterface 核心方法是否完整
- [ ] 能力接口 (ModelSwitcher, Compactable, PermissionController) 命名是否清晰

#### A2. 类型安全
- [ ] AgentEvent 联合类型是否覆盖所有场景
- [ ] GatewayEvent 36 个事件类型定义是否无遗漏
- [ ] 类型守卫函数 (hasModelSwitcher, hasCompact) 实现是否正确
- [ ] QueryRequest 接口字段是否完整
- [ ] 避免使用 any 类型

#### A3. 代码质量
- [ ] registry.ts 工厂模式实现是否简洁
- [ ] event-bus.ts EventEmitter 继承是否合理
- [ ] permission.ts PermissionGateway 状态管理是否安全
- [ ] 错误处理是否完善
- [ ] 代码注释是否充分

### B. 架构设计审查清单

#### B1. 三层职责分离
- [ ] Channel 层是否只负责消息收发，不涉及会话管理
- [ ] Gateway 层是否不依赖具体 Channel 实现细节
- [ ] Agent Runner 层是否不知道消息来源
- [ ] 跨层调用是否都通过接口进行
- [ ] metadata 传递是否避免了跨层泄漏

#### B2. 依赖倒置
- [ ] ChannelAdapter 接口是否足够抽象
- [ ] AgentRunnerInterface 是否与具体实现解耦
- [ ] 能力接口是否支持多种 Agent 实现
- [ ] Registry 是否支持动态注册和创建
- [ ] 依赖方向是否正确 (高层不依赖低层)

#### B3. 模块独立性
- [ ] Channel 层是否可独立使用
- [ ] Gateway 层是否可嵌入第三方系统
- [ ] Agent Runner 是否可替换 (Claude → Gemini)
- [ ] 新增 Channel 是否只需实现接口 + 注册
- [ ] 新增 Agent 是否只需实现接口 + 注册

### C. 实现逻辑审查清单

#### C1. Channel 层改造
- [ ] isGroupChat() 方法设计是否合理
- [ ] 群聊判断结果持久化到 Session 是否正确
- [ ] 群聊解散处理 (onChatDissolved) 是否完整
- [ ] FeishuChannel 移除 db 依赖是否彻底
- [ ] ReplyContext 传递是否避免了 rootId 泄漏

#### C2. Gateway 层增强
- [ ] EventBus 36 个事件是否覆盖完整生命周期
- [ ] EventBus 错误隔离机制是否有效
- [ ] PermissionGateway 的 cancelAll 是否防止内存泄漏
- [ ] 消息去重机制是否合理 (1 分钟窗口)
- [ ] SessionManager 的 deleted_at 软删除是否正确

#### C3. Agent Runner 标准化
- [ ] AgentEvent 类型是否覆盖所有 SDK 事件
- [ ] complete 事件不携带 result 的设计是否合理
- [ ] error 事件的 errorType 预分类是否完整
- [ ] 能力接口的类型守卫是否正确
- [ ] ClaudeRunner 事件转换逻辑是否完整

#### C4. 关键设计决策
- [ ] /perm 快速路径命令是否避免死锁
- [ ] StreamFlusher 与 AgentEvent 集成是否正确
- [ ] IdleMonitor 空闲判定是否合理
- [ ] 自动 compact 重试逻辑是否在正确的层
- [ ] Registry 实例注入模式是否支持测试隔离

## 审查执行计划

### Phase 1: 代码规范审查 (预计 2 小时)
- 审查接口定义文件
- 审查新建模块代码
- 生成代码规范审查报告

### Phase 2: 架构设计审查 (预计 2 小时)
- 审查三层职责划分
- 审查依赖关系图
- 生成架构契合度报告

### Phase 3: 实现逻辑审查 (预计 3 小时)
- 逐模块审查实现方案
- 对比现有代码与重构方案
- 生成实现逻辑审查报告

### Phase 4: 风险评估 (预计 1 小时)
- 评估风险控制措施
- 识别潜在遗漏风险
- 生成风险评估报告

