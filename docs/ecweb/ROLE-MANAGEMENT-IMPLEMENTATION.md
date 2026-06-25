# ECWeb 对端角色管理实施方案

> 版本：v1.0  
> 日期：2026-06-24  
> 状态：待实施

---

## 📋 目录

1. [概述](#概述)
2. [功能规划](#功能规划)
3. [技术架构](#技术架构)
4. [实施步骤](#实施步骤)
5. [API 接口](#api-接口)
6. [前端组件](#前端组件)
7. [测试计划](#测试计划)

---

## 概述

### 背景

EvolClaw 已实现完整的五级角色权限体系：
- Owner - 完全控制
- Admin - 需要确认
- Member - 基本权限
- Guest - 只读访客
- Anonymous - 未认证

ECWeb 需要提供可视化界面来管理这些角色。

### 目标

1. Agent 级角色管理（owners/admins/members）
2. 对端关系列表和角色显示
3. 单个对端的详细管理
4. 权限预览和验证

### 范围

**本期实施**：
- ✅ Agent 角色管理页面
- ✅ 关系列表页面
- ✅ 基础 API 接口
- ✅ 权限验证

**后期扩展**：
- 🔄 批量操作
- 🔄 操作日志
- 🔄 高级搜索

---

## 功能规划

### 功能 1: Agent 角色管理

**路由**: `/agents/:agentId/roles`

**功能点**：
1. 显示当前 agent 的 owners/admins/members 列表
2. 添加用户到角色列表（输入 AID）
3. 从角色列表移除用户
4. 角色说明和权限对比

**权限要求**：
- 查看：所有已认证用户
- 修改：仅 Owner

### 功能 2: 关系列表

**路由**: `/agents/:agentId/relations`

**功能点**：
1. 列出所有对端关系
2. 显示每个对端的角色（推导或显式）
3. 搜索和筛选
4. 快速跳转到详情

**权限要求**：
- 查看：Owner/Admin
- 修改：通过详情页

### 功能 3: 对端详情

**路由**: `/agents/:agentId/relations/:peerKey`

**功能点**：
1. 显示对端基本信息
2. 当前角色和来源
3. 角色分配操作
4. 有效权限预览

**权限要求**：
- 查看：Owner/Admin
- 修改：Owner

---

## 技术架构

### 前端技术栈

```typescript
// 技术选型
- 框架: React 18
- 语言: TypeScript 5
- 路由: React Router 6
- 状态: SWR / React Query
- UI: Ant Design / shadcn/ui
- 请求: Axios
```

### 后端技术栈

```typescript
// 现有技术
- 运行时: Node.js
- 框架: Express / Koa
- 配置: ConfigManager (已实现)
- 角色: RoleResolver (已实现)
```

### 目录结构

```
ecweb/
├── src/
│   ├── pages/
│   │   ├── agents/
│   │   │   ├── [agentId]/
│   │   │   │   ├── roles/
│   │   │   │   │   └── index.tsx           # Agent 角色管理
│   │   │   │   ├── relations/
│   │   │   │   │   ├── index.tsx           # 关系列表
│   │   │   │   │   └── [peerKey].tsx       # 对端详情
│   │   │   │   └── settings.tsx
│   │   ├── api/
│   │   │   └── agents/
│   │   │       └── [agentId]/
│   │   │           ├── roles.ts            # 角色 API
│   │   │           └── relations.ts        # 关系 API
│   ├── components/
│   │   ├── AgentRoleManager.tsx
│   │   ├── RoleSection.tsx
│   │   ├── RelationsList.tsx
│   │   ├── RelationItem.tsx
│   │   └── PermissionPreview.tsx
│   ├── hooks/
│   │   ├── useAgentRoles.ts
│   │   ├── useRelations.ts
│   │   └── useRelationDetail.ts
│   ├── types/
│   │   └── roles.ts
│   └── utils/
│       └── api.ts
```

---

## 实施步骤

### Phase 1: 基础设施（3 天）

#### 任务 1.1: 类型定义
```typescript
// src/types/roles.ts
export type RoleName = 'owner' | 'admin' | 'member' | 'guest' | 'anonymous';

export interface AgentRoles {
  owners: string[];
  admins: string[];
  members: string[];
}

export interface Relation {
  peerKey: string;
  peerId: string;
  peerName?: string;
  channelType: string;
  role: RoleName;
  roleSource: 'agent' | 'explicit';
  lastActive?: string;
}

export interface RelationDetail extends Relation {
  effectiveConfig: {
    permissionMode: string;
    model: string;
    dispatch: string;
    chatmode?: any;
  };
}
```

#### 任务 1.2: API 客户端
```typescript
// src/utils/api.ts
import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

export const agentRolesAPI = {
  get: (agentId: string) => 
    api.get(`/agents/${agentId}/roles`),
  
  addRole: (agentId: string, role: string, userId: string) =>
    api.post(`/agents/${agentId}/roles/${role}`, { userId }),
  
  removeRole: (agentId: string, role: string, userId: string) =>
    api.delete(`/agents/${agentId}/roles/${role}/${userId}`),
};

export const relationsAPI = {
  list: (agentId: string) =>
    api.get(`/agents/${agentId}/relations`),
  
  get: (agentId: string, peerKey: string) =>
    api.get(`/agents/${agentId}/relations/${encodeURIComponent(peerKey)}`),
  
  updateRole: (agentId: string, peerKey: string, role: RoleName | null) =>
    api.put(`/agents/${agentId}/relations/${encodeURIComponent(peerKey)}/role`, { role }),
};
```

#### 任务 1.3: Hooks
```typescript
// src/hooks/useAgentRoles.ts
import useSWR from 'swr';
import { agentRolesAPI } from '../utils/api';

export function useAgentRoles(agentId: string) {
  const { data, error, mutate } = useSWR(
    `/agents/${agentId}/roles`,
    () => agentRolesAPI.get(agentId).then(res => res.data)
  );

  const addRole = async (role: string, userId: string) => {
    await agentRolesAPI.addRole(agentId, role, userId);
    mutate();
  };

  const removeRole = async (role: string, userId: string) => {
    await agentRolesAPI.removeRole(agentId, role, userId);
    mutate();
  };

  return {
    roles: data,
    isLoading: !error && !data,
    isError: error,
    addRole,
    removeRole,
  };
}
```

---

### Phase 2: Agent 角色管理页面（5 天）

#### 任务 2.1: 页面路由
```tsx
// src/pages/agents/[agentId]/roles/index.tsx
import { useParams } from 'react-router-dom';
import { AgentRoleManager } from '@/components/AgentRoleManager';

export default function AgentRolesPage() {
  const { agentId } = useParams<{ agentId: string }>();
  
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">角色管理</h1>
      <AgentRoleManager agentId={agentId!} />
    </div>
  );
}
```

#### 任务 2.2: 主组件
```tsx
// src/components/AgentRoleManager.tsx
import { useState } from 'react';
import { useAgentRoles } from '@/hooks/useAgentRoles';
import { RoleSection } from './RoleSection';
import { Button, message } from 'antd';

export function AgentRoleManager({ agentId }: { agentId: string }) {
  const { roles, isLoading, addRole, removeRole } = useAgentRoles(agentId);

  if (isLoading) return <div>加载中...</div>;

  return (
    <div className="space-y-8">
      <RoleSection
        title="Owners"
        description="完全控制权限，可以管理所有设置"
        users={roles.owners}
        onAdd={(userId) => addRole('owner', userId)}
        onRemove={(userId) => removeRole('owner', userId)}
      />

      <RoleSection
        title="Admins"
        description="管理员权限，需要逐次确认操作"
        users={roles.admins}
        onAdd={(userId) => addRole('admin', userId)}
        onRemove={(userId) => removeRole('admin', userId)}
      />

      <RoleSection
        title="Members"
        description="团队成员，有基本使用权限"
        users={roles.members}
        onAdd={(userId) => addRole('member', userId)}
        onRemove={(userId) => removeRole('member', userId)}
      />
    </div>
  );
}
```

#### 任务 2.3: 角色区块组件
```tsx
// src/components/RoleSection.tsx
import { useState } from 'react';
import { Card, List, Button, Input, Modal, message } from 'antd';
import { PlusOutlined, DeleteOutlined, UserOutlined } from '@ant-design/icons';

interface RoleSectionProps {
  title: string;
  description: string;
  users: string[];
  onAdd: (userId: string) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}

export function RoleSection({ title, description, users, onAdd, onRemove }: RoleSectionProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newUserId, setNewUserId] = useState('');

  const handleAdd = async () => {
    if (!newUserId.trim()) {
      message.error('请输入有效的用户 ID');
      return;
    }

    try {
      await onAdd(newUserId.trim());
      message.success('添加成功');
      setNewUserId('');
      setIsAdding(false);
    } catch (error) {
      message.error('添加失败');
    }
  };

  const handleRemove = async (userId: string) => {
    Modal.confirm({
      title: '确认移除',
      content: `确定要移除 ${userId} 吗？`,
      onOk: async () => {
        try {
          await onRemove(userId);
          message.success('移除成功');
        } catch (error) {
          message.error('移除失败');
        }
      },
    });
  };

  return (
    <Card title={title} extra={description}>
      <List
        dataSource={users}
        renderItem={(userId) => (
          <List.Item
            actions={[
              <Button
                type="link"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleRemove(userId)}
              >
                移除
              </Button>,
            ]}
          >
            <List.Item.Meta
              avatar={<UserOutlined />}
              title={userId}
            />
          </List.Item>
        )}
      />

      {isAdding ? (
        <div className="mt-4 flex gap-2">
          <Input
            placeholder="输入 AID (如: alice.aid.pub)"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            onPressEnter={handleAdd}
          />
          <Button type="primary" onClick={handleAdd}>
            确认
          </Button>
          <Button onClick={() => setIsAdding(false)}>
            取消
          </Button>
        </div>
      ) : (
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => setIsAdding(true)}
          className="mt-4 w-full"
        >
          添加 {title}
        </Button>
      )}
    </Card>
  );
}
```

---

### Phase 3: 关系列表页面（4 天）

#### 任务 3.1: 关系列表页
```tsx
// src/pages/agents/[agentId]/relations/index.tsx
import { useParams } from 'react-router-dom';
import { RelationsList } from '@/components/RelationsList';

export default function RelationsPage() {
  const { agentId } = useParams<{ agentId: string }>();
  
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">对端关系管理</h1>
      <RelationsList agentId={agentId!} />
    </div>
  );
}
```

#### 任务 3.2: 关系列表组件
```tsx
// src/components/RelationsList.tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { List, Input, Select, Tag, Button } from 'antd';
import { useRelations } from '@/hooks/useRelations';
import type { Relation, RoleName } from '@/types/roles';

const roleColors: Record<RoleName, string> = {
  owner: 'red',
  admin: 'orange',
  member: 'blue',
  guest: 'green',
  anonymous: 'default',
};

export function RelationsList({ agentId }: { agentId: string }) {
  const { relations, isLoading } = useRelations(agentId);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleName | 'all'>('all');

  const filtered = relations
    ?.filter(rel => {
      if (search && !rel.peerId.includes(search) && !rel.peerName?.includes(search)) {
        return false;
      }
      if (roleFilter !== 'all' && rel.role !== roleFilter) {
        return false;
      }
      return true;
    });

  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        <Input
          placeholder="搜索对端 ID 或名称"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1"
        />
        <Select
          value={roleFilter}
          onChange={setRoleFilter}
          style={{ width: 150 }}
        >
          <Select.Option value="all">所有角色</Select.Option>
          <Select.Option value="owner">Owner</Select.Option>
          <Select.Option value="admin">Admin</Select.Option>
          <Select.Option value="member">Member</Select.Option>
          <Select.Option value="guest">Guest</Select.Option>
          <Select.Option value="anonymous">Anonymous</Select.Option>
        </Select>
      </div>

      <List
        loading={isLoading}
        dataSource={filtered}
        renderItem={(relation) => (
          <List.Item
            actions={[
              <Link to={`/agents/${agentId}/relations/${encodeURIComponent(relation.peerKey)}`}>
                <Button type="link">详情</Button>
              </Link>,
            ]}
          >
            <List.Item.Meta
              title={relation.peerName || relation.peerId}
              description={
                <div className="space-y-1">
                  <div>ID: {relation.peerId}</div>
                  <div>渠道: {relation.channelType}</div>
                </div>
              }
            />
            <div className="flex items-center gap-2">
              <Tag color={roleColors[relation.role]}>
                {relation.role}
              </Tag>
              <span className="text-gray-500 text-sm">
                ({relation.roleSource === 'agent' ? 'agent 级' : '关系级'})
              </span>
            </div>
          </List.Item>
        )}
      />
    </div>
  );
}
```

---

### Phase 4: 后端 API（3 天）

#### 任务 4.1: 角色管理 API
```typescript
// src/api/agents/[agentId]/roles.ts
import { read, write, ConfigTarget } from '@/config/config-manager';
import type { AgentConfig } from '@/types';

export async function GET(req: Request) {
  const { agentId } = req.params;
  
  const config = read<AgentConfig>(ConfigTarget.Agent, { self: agentId });
  
  return Response.json({
    owners: config?.owners || [],
    admins: config?.admins || [],
    members: config?.members || [],
  });
}

export async function POST(req: Request) {
  const { agentId, role } = req.params;
  const { userId } = await req.json();
  
  // 权限检查：只有 owner 可以修改
  const currentUserRole = await resolveUserRole(agentId, req.user.id);
  if (currentUserRole !== 'owner') {
    return Response.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  
  const config = read<AgentConfig>(ConfigTarget.Agent, { self: agentId }) || {
    aid: agentId,
    channels: [],
  };
  
  const roleKey = `${role}s` as 'owners' | 'admins' | 'members';
  if (!config[roleKey]) config[roleKey] = [];
  
  if (!config[roleKey]!.includes(userId)) {
    config[roleKey]!.push(userId);
  }
  
  write(ConfigTarget.Agent, config, { self: agentId });
  
  return Response.json({ success: true });
}

export async function DELETE(req: Request) {
  const { agentId, role, userId } = req.params;
  
  // 权限检查
  const currentUserRole = await resolveUserRole(agentId, req.user.id);
  if (currentUserRole !== 'owner') {
    return Response.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  
  const config = read<AgentConfig>(ConfigTarget.Agent, { self: agentId });
  if (!config) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }
  
  const roleKey = `${role}s` as 'owners' | 'admins' | 'members';
  if (config[roleKey]) {
    config[roleKey] = config[roleKey]!.filter(id => id !== userId);
  }
  
  write(ConfigTarget.Agent, config, { self: agentId });
  
  return Response.json({ success: true });
}
```

#### 任务 4.2: 关系管理 API
```typescript
// src/api/agents/[agentId]/relations.ts
import fs from 'fs';
import path from 'path';
import { agentRelationsDir } from '@/paths';
import { resolveUserRole } from '@/config/role-resolver';
import { parsePeerKey } from '@/core/relation/peer-identity';

export async function GET(req: Request) {
  const { agentId } = req.params;
  
  // 权限检查：owner 或 admin 可以查看
  const currentUserRole = await resolveUserRole(agentId, req.user.id);
  if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
    return Response.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  
  const relationsPath = agentRelationsDir(agentId);
  
  if (!fs.existsSync(relationsPath)) {
    return Response.json([]);
  }
  
  const peerKeys = fs.readdirSync(relationsPath);
  
  const relations = peerKeys.map(peerKey => {
    try {
      const { channelType, channelId } = parsePeerKey(peerKey);
      const role = resolveUserRole(agentId, peerKey);
      
      // 检查是否有显式设置（relations/config.json 或 behavior.json）
      const hasExplicitConfig = fs.existsSync(
        path.join(relationsPath, peerKey, 'config.json')
      ) || fs.existsSync(
        path.join(relationsPath, peerKey, 'behavior.json')
      );
      
      return {
        peerKey,
        peerId: channelId,
        channelType,
        role,
        roleSource: hasExplicitConfig ? 'explicit' : 'agent',
      };
    } catch (error) {
      console.warn(`Failed to process relation ${peerKey}:`, error);
      return null;
    }
  }).filter(Boolean);
  
  return Response.json(relations);
}
```

---

## API 接口

### 接口列表

#### 1. 获取 Agent 角色
```http
GET /api/agents/:agentId/roles

Response 200:
{
  "owners": ["alice.aid.pub"],
  "admins": ["bob.aid.pub"],
  "members": ["charlie.aid.pub"]
}
```

#### 2. 添加角色
```http
POST /api/agents/:agentId/roles/:role
Content-Type: application/json

Body:
{
  "userId": "dave.aid.pub"
}

Response 200:
{
  "success": true
}

Response 403:
{
  "error": "Insufficient permissions"
}
```

#### 3. 移除角色
```http
DELETE /api/agents/:agentId/roles/:role/:userId

Response 200:
{
  "success": true
}
```

#### 4. 列出关系
```http
GET /api/agents/:agentId/relations

Response 200:
[
  {
    "peerKey": "aun#alice.aid.pub",
    "peerId": "alice.aid.pub",
    "channelType": "aun",
    "role": "owner",
    "roleSource": "agent"
  }
]
```

#### 5. 获取关系详情
```http
GET /api/agents/:agentId/relations/:peerKey

Response 200:
{
  "peerKey": "aun#alice.aid.pub",
  "peerId": "alice.aid.pub",
  "channelType": "aun",
  "role": "owner",
  "roleSource": "agent",
  "effectiveConfig": {
    "permissionMode": "bypass",
    "model": "claude-opus-4-8",
    "dispatch": "broadcast"
  }
}
```

---

## 测试计划

### 单元测试

```typescript
// tests/AgentRoleManager.test.tsx
describe('AgentRoleManager', () => {
  it('should display current roles', () => {
    // ...
  });
  
  it('should add a new owner', () => {
    // ...
  });
  
  it('should remove an admin', () => {
    // ...
  });
});
```

### 集成测试

```typescript
// tests/api/roles.test.ts
describe('Roles API', () => {
  it('should get agent roles', () => {
    // ...
  });
  
  it('should require owner permission to add role', () => {
    // ...
  });
});
```

### E2E 测试

```typescript
// tests/e2e/role-management.spec.ts
describe('Role Management Flow', () => {
  it('should manage roles end-to-end', () => {
    // 1. 登录为 owner
    // 2. 进入角色管理页
    // 3. 添加 admin
    // 4. 验证添加成功
    // 5. 移除 admin
    // 6. 验证移除成功
  });
});
```

---

## 实施时间表

| Phase | 任务 | 时长 | 责任人 | 状态 |
|-------|------|------|--------|------|
| 1 | 基础设施 | 3 天 | 前端 | ⏳ 待开始 |
| 2 | Agent 角色管理 | 5 天 | 前端 | ⏳ 待开始 |
| 3 | 关系列表 | 4 天 | 前端 | ⏳ 待开始 |
| 4 | 后端 API | 3 天 | 后端 | ⏳ 待开始 |
| 5 | 测试 | 2 天 | QA | ⏳ 待开始 |
| 6 | 部署 | 1 天 | DevOps | ⏳ 待开始 |

**总计**: 18 天（约 3-4 周）

---

## 注意事项

### 安全性

1. **权限验证**：所有写操作必须验证权限
2. **输入验证**：验证 AID 格式
3. **XSS 防护**：用户输入需要转义

### 性能

1. **分页加载**：关系列表超过 100 条时分页
2. **缓存策略**：使用 SWR 自动缓存
3. **懒加载**：详情页按需加载

### 用户体验

1. **加载状态**：所有异步操作显示加载中
2. **错误提示**：操作失败给出清晰提示
3. **确认对话框**：删除操作需要确认

---

## 附录

### A. 角色权限对比表

| 权限 | Owner | Admin | Member | Guest | Anonymous |
|------|-------|-------|--------|-------|-----------|
| permissionMode | bypass | request | auto | readonly | readonly |
| 可用模型 | 所有 | opus/sonnet/haiku | sonnet/haiku | haiku | haiku |
| dispatch | 可配置 | 可配置 | mention | mention | mention |
| chatmode | 可配置 | 可配置 | 不可配置 | 不可配置 | 不可配置 |

### B. peerKey 格式说明

```
格式: channel#encodedId

示例:
- aun#alice.aid.pub
- aun#group_dev_team
- feishu#ou_12345
- wechat#wxid_abc123
```

---

**文档维护**: Claude (Opus 4.8)  
**创建日期**: 2026-06-24  
**最后更新**: 2026-06-24
