# 双会话响应模式 - 实施计划 V2（总结版）

**版本**: 2.0  
**日期**: 2026-07-04  
**基于**: 响应模式架构 V2

---

## 一、实施策略变化

### 原计划 vs 新计划

| 方面 | 原计划 | 新计划 |
|------|--------|--------|
| 架构 | 扩展现有 response-modes | 新建 response-system 体系 |
| V1 模式 | 保持不变 | 迁移到新体系 |
| V2 引擎 | 作为新的响应模式 | 作为独立引擎 |
| 工作量 | 2-3 周 | 3-4 周 |

### 优势

- ✅ V1 和 V2 完全隔离
- ✅ 现有系统零影响
- ✅ 架构更清晰
- ✅ 未来扩展性更好

---

## 二、实施阶段

### Phase 1：搭建框架（3 天）

**创建目录**：
```
src/response-system/
├── engines/
│   ├── v1/
│   └── v2/
├── modes/
│   ├── interactive/
│   ├── proactive/
│   └── dual-session-lite/
├── registry.ts
├── selector.ts
└── types.ts
```

**关键产出**：
- 响应模式注册表
- 响应模式选择器
- 公共类型定义

---

### Phase 2：迁移 V1 引擎（4 天）

**任务**：
1. 定义 V1ResponseMode 接口
2. 迁移现有 registry/coordinator
3. 迁移 interactive 模式
4. 迁移 proactive 模式
5. 集成到 response-engine.ts

**验收**：
- [ ] 现有功能完全兼容
- [ ] 回归测试通过

---

### Phase 3：实现 V2 引擎（2 周）

**组件清单**：
```
engines/v2/
├── types.ts              # 内部类型
├── auxiliary-queue.ts    # 辅助队列
├── auxiliary-session.ts  # 辅助会话
├── main-queue.ts         # 主队列
├── main-session.ts       # 主会话
└── engine.ts             # V2 引擎核心
```

**响应模式**：
```
modes/dual-session-lite/
└── index.ts              # 薄包装 V2Engine
```

**验收**：
- [ ] 双队列机制正常
- [ ] 辅助会话决策正确
- [ ] 主会话处理正常
- [ ] 错误处理完善

---

### Phase 4：ECK 集成（1-2 天）

**任务**：
- 更新 manifest 配置
- 扩展 ECK vars
- 渲染辅助/主会话提示词

---

### Phase 5：适配器修改（1 天）

**任务**：
- 修改 aun.ts mention 过滤
- 保留 isMentioned 标记

---

### Phase 6：测试（1 周）

**测试范围**：
- V1 引擎回归测试
- V2 引擎功能测试
- 架构隔离测试
- 性能测试

---

## 三、工作量估算

| 阶段 | 工作量 | 人员 |
|------|--------|------|
| Phase 1 | 3 天 | 1 人 |
| Phase 2 | 4 天 | 1 人 |
| Phase 3 | 10 天 | 1-2 人 |
| Phase 4 | 1-2 天 | 1 人 |
| Phase 5 | 1 天 | 1 人 |
| Phase 6 | 5 天 | 1 人 |
| **总计** | **3-4 周** | **1-2 人** |

---

## 四、关键里程碑

- [ ] Phase 1 完成：框架搭建完成
- [ ] Phase 2 完成：V1 迁移完成，现有功能正常
- [ ] Phase 3 完成：V2 引擎实现完成
- [ ] Phase 4-5 完成：集成完成
- [ ] Phase 6 完成：测试通过，可发布

---

**完整实施计划参考**：
- `docs/response-system/RESPONSE-MODE-ARCHITECTURE-V2.md`（架构设计）
- `docs/response-system/dual-session-lite/ARCHITECTURE-FINAL.md`（详细架构）
- `docs/response-system/dual-session-lite/IMPLEMENTATION-PLAN.md`（原实施计划）

---

**维护者**: Claude Code  
**状态**: ✅ 可实施
