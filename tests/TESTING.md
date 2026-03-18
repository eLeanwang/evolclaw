# EvolClaw 测试指南

## 测试结构

```
tests/
├── unit/                    # 单元测试
│   ├── message-queue.test.ts
│   ├── session-manager.test.ts
│   ├── database.test.ts
│   └── hook-collector.test.ts
└── integration/             # 集成测试
    ├── feishu.test.ts
    ├── aun.test.ts
    └── e2e.test.ts
```

## 运行测试

```bash
# 所有测试
npm test

# 单元测试
npm test tests/unit

# 集成测试
npm test tests/integration

# 监听模式
npm run test:watch

# 覆盖率报告
npm test -- --coverage
```

## 测试覆盖

### 单元测试

- **MessageQueue**: 消息队列顺序性、并发处理
- **SessionManager**: 会话创建、复用
- **Database**: 数据存储、查询
- **HookCollector**: Hook 事件收集、超时检测

### 集成测试

- **Feishu**: 连接、消息收发
- **AUN**: 协议集成、消息路由
- **E2E**: 端到端流程

## 测试数据

测试使用独立的数据目录 `./data/test/`，测试后自动清理。

## CI/CD

GitHub Actions 配置示例：

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm install
      - run: npm test
```
