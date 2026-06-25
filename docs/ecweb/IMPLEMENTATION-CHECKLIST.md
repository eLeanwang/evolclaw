# ECWeb 角色管理实施检查清单

> 版本：v1.0  
> 日期：2026-06-24  
> 用途：逐项检查实施进度

---

## 📋 Phase 1: 基础设施（3 天）

### 类型定义
- [ ] 创建 `src/types/roles.ts`
  - [ ] RoleName 类型
  - [ ] AgentRoles 接口
  - [ ] Relation 接口
  - [ ] RelationDetail 接口

### API 客户端
- [ ] 创建 `src/utils/api.ts`
  - [ ] axios 实例配置
  - [ ] agentRolesAPI 对象
  - [ ] relationsAPI 对象
  - [ ] 错误拦截器

### Hooks
- [ ] 创建 `src/hooks/useAgentRoles.ts`
  - [ ] useSWR 集成
  - [ ] addRole 方法
  - [ ] removeRole 方法
  - [ ] 错误处理

- [ ] 创建 `src/hooks/useRelations.ts`
  - [ ] useSWR 集成
  - [ ] 数据转换
  - [ ] refresh 方法

- [ ] 创建 `src/hooks/useRelationDetail.ts`
  - [ ] 详情数据获取
  - [ ] effectiveConfig 解析

---

## 📋 Phase 2: Agent 角色管理（5 天）

### 页面组件
- [ ] 创建 `src/pages/agents/[agentId]/roles/index.tsx`
  - [ ] 路由参数解析
  - [ ] 页面布局
  - [ ] 面包屑导航

### 主组件
- [ ] 创建 `src/components/AgentRoleManager.tsx`
  - [ ] 三个 RoleSection
  - [ ] 角色说明 Alert
  - [ ] 权限对比表
  - [ ] 加载状态
  - [ ] 错误状态

### 角色区块
- [ ] 创建 `src/components/RoleSection.tsx`
  - [ ] 用户列表
  - [ ] 添加表单
  - [ ] AID 格式验证
  - [ ] 删除确认对话框
  - [ ] 加载状态
  - [ ] 权限标签

---

## 📋 Phase 3: 关系列表（4 天）

### 列表页面
- [ ] 创建 `src/pages/agents/[agentId]/relations/index.tsx`
  - [ ] 页面布局
  - [ ] 搜索栏
  - [ ] 筛选器

### 列表组件
- [ ] 创建 `src/components/RelationsList.tsx`
  - [ ] 数据加载
  - [ ] 搜索功能
  - [ ] 角色筛选
  - [ ] 渠道筛选
  - [ ] 分页（可选）
  - [ ] 空状态

### 列表项
- [ ] 创建 `src/components/RelationItem.tsx`
  - [ ] 用户图标
  - [ ] 基本信息
  - [ ] 角色标签
  - [ ] 详情链接

---

## 📋 Phase 4: 对端详情（3 天）

### 详情页面
- [ ] 创建 `src/pages/agents/[agentId]/relations/[peerKey].tsx`
  - [ ] 路由参数解析（peerKey 解码）
  - [ ] 页面布局
  - [ ] 返回按钮

### 详情组件
- [ ] 创建 `src/components/RelationDetail.tsx`
  - [ ] 基本信息卡片
  - [ ] 当前角色显示
  - [ ] 角色来源标识
  - [ ] 权限预览

### 权限预览
- [ ] 创建 `src/components/PermissionPreview.tsx`
  - [ ] permissionMode
  - [ ] model
  - [ ] dispatch
  - [ ] chatmode
  - [ ] 其他配置项

---

## 📋 Phase 5: 后端 API（3 天）

### 角色管理 API
- [ ] 实现 `GET /api/agents/:agentId/roles`
  - [ ] 读取 agent config
  - [ ] 返回 owners/admins/members
  - [ ] 错误处理

- [ ] 实现 `POST /api/agents/:agentId/roles/:role`
  - [ ] 参数验证
  - [ ] 权限检查（owner only）
  - [ ] AID 格式验证
  - [ ] 重复检查
  - [ ] 写入配置

- [ ] 实现 `DELETE /api/agents/:agentId/roles/:role/:userId`
  - [ ] 权限检查
  - [ ] 最后一个 owner 保护
  - [ ] 写入配置

### 关系管理 API
- [ ] 实现 `GET /api/agents/:agentId/relations`
  - [ ] 权限检查（owner/admin）
  - [ ] 扫描 relations 目录
  - [ ] 解析 peerKey
  - [ ] 角色推导
  - [ ] 来源判断

- [ ] 实现 `GET /api/agents/:agentId/relations/:peerKey`
  - [ ] 权限检查
  - [ ] peerKey 解码
  - [ ] resolveEffective 调用
  - [ ] 返回详细配置

### 中间件
- [ ] 实现 `src/middleware/auth.ts`
  - [ ] JWT 验证
  - [ ] 用户信息提取
  - [ ] 错误处理

- [ ] 实现 `src/middleware/permission.ts`
  - [ ] requireRole 工厂函数
  - [ ] 角色优先级检查
  - [ ] 错误响应

---

## 📋 Phase 6: 测试（2 天）

### 单元测试
- [ ] RoleSection 组件测试
  - [ ] 渲染测试
  - [ ] 添加用户测试
  - [ ] 移除用户测试
  - [ ] 验证测试

- [ ] RelationsList 组件测试
  - [ ] 渲染测试
  - [ ] 搜索测试
  - [ ] 筛选测试

### API 测试
- [ ] Roles API 测试
  - [ ] GET 测试
  - [ ] POST 测试（成功）
  - [ ] POST 测试（权限）
  - [ ] POST 测试（验证）
  - [ ] DELETE 测试（成功）
  - [ ] DELETE 测试（最后 owner）

- [ ] Relations API 测试
  - [ ] GET list 测试
  - [ ] GET detail 测试
  - [ ] 权限测试

### E2E 测试
- [ ] 完整角色管理流程
  - [ ] 登录
  - [ ] 进入角色管理
  - [ ] 添加 admin
  - [ ] 验证添加
  - [ ] 移除 admin
  - [ ] 验证移除

---

## 📋 Phase 7: 部署（1 天）

### 前端部署
- [ ] 构建生产版本
- [ ] 环境变量配置
- [ ] CDN 配置（如需要）
- [ ] 部署到服务器

### 后端部署
- [ ] 环境变量配置
- [ ] 数据库迁移（如需要）
- [ ] API 服务部署
- [ ] 健康检查

### 监控
- [ ] 错误监控
- [ ] 性能监控
- [ ] 日志收集

---

## 📋 验收标准

### 功能完整性
- [ ] Owner 可以添加/删除所有角色
- [ ] Admin 可以查看关系列表
- [ ] 角色正确显示和识别
- [ ] 权限预览准确
- [ ] 搜索和筛选正常工作

### 安全性
- [ ] 所有 API 需要认证
- [ ] 权限检查生效
- [ ] 不能删除最后一个 owner
- [ ] AID 格式正确验证

### 用户体验
- [ ] 加载状态显示
- [ ] 错误提示清晰
- [ ] 操作需要确认
- [ ] 响应及时（< 2s）

### 性能
- [ ] 关系列表加载 < 1s
- [ ] API 响应 < 500ms
- [ ] 前端打包 < 1MB

### 兼容性
- [ ] Chrome 最新版
- [ ] Firefox 最新版
- [ ] Safari 最新版
- [ ] Edge 最新版

---

## 📋 文档完整性

- [x] 实施方案 (ROLE-MANAGEMENT-IMPLEMENTATION.md)
- [x] 前端组件指南 (FRONTEND-COMPONENTS-GUIDE.md)
- [x] 后端 API 指南 (BACKEND-API-GUIDE.md)
- [x] 实施检查清单 (本文档)
- [ ] API 文档（Swagger/OpenAPI）
- [ ] 用户手册
- [ ] 运维手册

---

## 📋 交付物

### 代码
- [ ] 前端代码（src/）
- [ ] 后端代码（api/）
- [ ] 测试代码（tests/）
- [ ] 配置文件

### 文档
- [ ] 技术文档
- [ ] API 文档
- [ ] 用户手册
- [ ] 部署文档

### 其他
- [ ] 演示视频/截图
- [ ] 测试报告
- [ ] 性能报告

---

## 🎯 里程碑

| 里程碑 | 日期 | 状态 |
|--------|------|------|
| Phase 1 完成 | Day 3 | ⏳ |
| Phase 2 完成 | Day 8 | ⏳ |
| Phase 3 完成 | Day 12 | ⏳ |
| Phase 4 完成 | Day 15 | ⏳ |
| Phase 5 完成 | Day 18 | ⏳ |
| Phase 6 完成 | Day 20 | ⏳ |
| Phase 7 完成 | Day 21 | ⏳ |

**总工期**: 21 个工作日（约 4-5 周）

---

## 📞 联系人

| 角色 | 姓名 | 职责 |
|------|------|------|
| 项目负责人 | - | 整体协调 |
| 前端开发 | - | 页面和组件 |
| 后端开发 | - | API 实现 |
| 测试工程师 | - | 测试和验收 |
| DevOps | - | 部署和监控 |

---

**检查清单维护**: Claude (Opus 4.8)  
**创建日期**: 2026-06-24  
**最后更新**: 2026-06-24
