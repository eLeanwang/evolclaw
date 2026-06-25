# ECWeb 前端组件开发指南

> 版本：v1.0  
> 日期：2026-06-24

---

## 📋 目录

1. [组件清单](#组件清单)
2. [完整代码](#完整代码)
3. [样式指南](#样式指南)
4. [状态管理](#状态管理)
5. [测试用例](#测试用例)

---

## 组件清单

### 核心组件（6 个）

| 组件 | 路径 | 功能 | 优先级 |
|------|------|------|--------|
| AgentRoleManager | components/AgentRoleManager.tsx | Agent 角色管理主组件 | P0 |
| RoleSection | components/RoleSection.tsx | 单个角色区块 | P0 |
| RelationsList | components/RelationsList.tsx | 关系列表 | P0 |
| RelationItem | components/RelationItem.tsx | 关系列表项 | P1 |
| RelationDetail | components/RelationDetail.tsx | 对端详情 | P1 |
| PermissionPreview | components/PermissionPreview.tsx | 权限预览 | P1 |

### Hooks（3 个）

| Hook | 功能 | 优先级 |
|------|------|--------|
| useAgentRoles | Agent 角色数据和操作 | P0 |
| useRelations | 关系列表数据 | P0 |
| useRelationDetail | 单个关系详情 | P1 |

---

## 完整代码

### 1. AgentRoleManager.tsx

```tsx
/**
 * Agent 角色管理主组件
 * 
 * 功能：
 * - 显示 owners/admins/members 三个角色区块
 * - 添加/删除用户到各角色
 * - 角色说明和权限对比
 */

import React from 'react';
import { Card, Tabs, Alert } from 'antd';
import { useAgentRoles } from '@/hooks/useAgentRoles';
import { RoleSection } from './RoleSection';
import { InfoCircleOutlined } from '@ant-design/icons';

interface AgentRoleManagerProps {
  agentId: string;
}

export function AgentRoleManager({ agentId }: AgentRoleManagerProps) {
  const { roles, isLoading, isError, addRole, removeRole } = useAgentRoles(agentId);

  if (isLoading) {
    return <Card loading />;
  }

  if (isError) {
    return (
      <Alert
        message="加载失败"
        description="无法加载角色信息，请稍后重试"
        type="error"
        showIcon
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* 角色说明 */}
      <Alert
        message="角色权限说明"
        description={
          <div className="space-y-2">
            <div><strong>Owner</strong>: 完全控制权限，可以管理所有设置和角色</div>
            <div><strong>Admin</strong>: 管理员权限，需要逐次确认敏感操作</div>
            <div><strong>Member</strong>: 团队成员，有基本使用权限</div>
          </div>
        }
        type="info"
        icon={<InfoCircleOutlined />}
        className="mb-6"
      />

      {/* 角色区块 */}
      <div className="space-y-6">
        <RoleSection
          role="owner"
          title="Owners"
          description="完全控制权限，可以管理所有设置"
          permissions={['管理角色', '修改配置', '使用所有模型', 'bypass 模式']}
          users={roles?.owners || []}
          onAdd={(userId) => addRole('owner', userId)}
          onRemove={(userId) => removeRole('owner', userId)}
        />

        <RoleSection
          role="admin"
          title="Admins"
          description="管理员权限，需要逐次确认敏感操作"
          permissions={['修改配置', '使用 opus/sonnet/haiku', 'request 模式']}
          users={roles?.admins || []}
          onAdd={(userId) => addRole('admin', userId)}
          onRemove={(userId) => removeRole('admin', userId)}
        />

        <RoleSection
          role="member"
          title="Members"
          description="团队成员，有基本使用权限"
          permissions={['基本对话', '使用 sonnet/haiku', 'auto 模式']}
          users={roles?.members || []}
          onAdd={(userId) => addRole('member', userId)}
          onRemove={(userId) => removeRole('member', userId)}
        />
      </div>

      {/* 权限对比表 */}
      <Card title="权限对比表" className="mt-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">权限</th>
              <th className="text-center p-2">Owner</th>
              <th className="text-center p-2">Admin</th>
              <th className="text-center p-2">Member</th>
              <th className="text-center p-2">Guest</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="p-2">permissionMode</td>
              <td className="text-center p-2">bypass</td>
              <td className="text-center p-2">request</td>
              <td className="text-center p-2">auto</td>
              <td className="text-center p-2">readonly</td>
            </tr>
            <tr className="border-b">
              <td className="p-2">可用模型</td>
              <td className="text-center p-2">所有</td>
              <td className="text-center p-2">opus/sonnet/haiku</td>
              <td className="text-center p-2">sonnet/haiku</td>
              <td className="text-center p-2">haiku</td>
            </tr>
            <tr className="border-b">
              <td className="p-2">dispatch</td>
              <td className="text-center p-2">可配置</td>
              <td className="text-center p-2">可配置</td>
              <td className="text-center p-2">mention</td>
              <td className="text-center p-2">mention</td>
            </tr>
            <tr>
              <td className="p-2">chatmode</td>
              <td className="text-center p-2">可配置</td>
              <td className="text-center p-2">可配置</td>
              <td className="text-center p-2">不可配置</td>
              <td className="text-center p-2">不可配置</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}
```

---

### 2. RoleSection.tsx

```tsx
/**
 * 角色区块组件
 * 
 * 功能：
 * - 显示角色用户列表
 * - 添加新用户
 * - 移除用户
 * - 权限说明
 */

import React, { useState } from 'react';
import { Card, List, Button, Input, Modal, message, Tag, Tooltip } from 'antd';
import { 
  PlusOutlined, 
  DeleteOutlined, 
  UserOutlined,
  CheckCircleOutlined 
} from '@ant-design/icons';

interface RoleSectionProps {
  role: 'owner' | 'admin' | 'member';
  title: string;
  description: string;
  permissions: string[];
  users: string[];
  onAdd: (userId: string) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}

const roleColors = {
  owner: 'red',
  admin: 'orange',
  member: 'blue',
};

export function RoleSection({
  role,
  title,
  description,
  permissions,
  users,
  onAdd,
  onRemove,
}: RoleSectionProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [loading, setLoading] = useState(false);

  const validateAid = (aid: string): boolean => {
    // AID 格式: xxx.aid.pub 或 xxx.agentid.pub
    return /^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(aid);
  };

  const handleAdd = async () => {
    const trimmedId = newUserId.trim();

    if (!trimmedId) {
      message.error('请输入用户 ID');
      return;
    }

    if (!validateAid(trimmedId)) {
      message.error('无效的 AID 格式，应为 xxx.aid.pub 或 xxx.agentid.pub');
      return;
    }

    if (users.includes(trimmedId)) {
      message.warning('该用户已在列表中');
      return;
    }

    setLoading(true);
    try {
      await onAdd(trimmedId);
      message.success('添加成功');
      setNewUserId('');
      setIsAdding(false);
    } catch (error: any) {
      message.error(error.message || '添加失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = (userId: string) => {
    Modal.confirm({
      title: '确认移除',
      content: (
        <div>
          <p>确定要从 {title} 中移除以下用户吗？</p>
          <p className="font-mono text-sm mt-2">{userId}</p>
        </div>
      ),
      okText: '确认',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await onRemove(userId);
          message.success('移除成功');
        } catch (error: any) {
          message.error(error.message || '移除失败');
        }
      },
    });
  };

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <span>{title}</span>
          <Tag color={roleColors[role]}>{users.length}</Tag>
        </div>
      }
      extra={
        <Tooltip title={permissions.join('、')}>
          <span className="text-sm text-gray-500">{description}</span>
        </Tooltip>
      }
    >
      {/* 用户列表 */}
      <List
        dataSource={users}
        locale={{ emptyText: '暂无用户' }}
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
              avatar={<UserOutlined className="text-lg" />}
              title={<span className="font-mono">{userId}</span>}
              description={
                <div className="flex gap-2">
                  {permissions.slice(0, 2).map(perm => (
                    <Tag key={perm} icon={<CheckCircleOutlined />} color="success">
                      {perm}
                    </Tag>
                  ))}
                </div>
              }
            />
          </List.Item>
        )}
      />

      {/* 添加用户 */}
      {isAdding ? (
        <div className="mt-4 flex gap-2">
          <Input
            placeholder="输入 AID (如: alice.aid.pub)"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            onPressEnter={handleAdd}
            disabled={loading}
            autoFocus
          />
          <Button type="primary" onClick={handleAdd} loading={loading}>
            确认
          </Button>
          <Button onClick={() => setIsAdding(false)} disabled={loading}>
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

### 3. RelationsList.tsx

```tsx
/**
 * 关系列表组件
 * 
 * 功能：
 * - 显示所有对端关系
 * - 搜索和筛选
 * - 角色标签
 * - 跳转详情
 */

import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { 
  List, 
  Input, 
  Select, 
  Tag, 
  Button, 
  Card,
  Empty,
  Spin 
} from 'antd';
import { 
  SearchOutlined, 
  FilterOutlined,
  UserOutlined,
  TeamOutlined 
} from '@ant-design/icons';
import { useRelations } from '@/hooks/useRelations';
import type { Relation, RoleName } from '@/types/roles';

const roleColors: Record<RoleName, string> = {
  owner: 'red',
  admin: 'orange',
  member: 'blue',
  guest: 'green',
  anonymous: 'default',
};

const roleLabels: Record<RoleName, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
  anonymous: 'Anonymous',
};

interface RelationsListProps {
  agentId: string;
}

export function RelationsList({ agentId }: RelationsListProps) {
  const { relations, isLoading, isError } = useRelations(agentId);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleName | 'all'>('all');
  const [channelFilter, setChannelFilter] = useState<string>('all');

  // 筛选后的数据
  const filtered = useMemo(() => {
    if (!relations) return [];

    return relations.filter(rel => {
      // 搜索过滤
      if (search) {
        const searchLower = search.toLowerCase();
        if (
          !rel.peerId.toLowerCase().includes(searchLower) &&
          !rel.peerName?.toLowerCase().includes(searchLower)
        ) {
          return false;
        }
      }

      // 角色过滤
      if (roleFilter !== 'all' && rel.role !== roleFilter) {
        return false;
      }

      // 渠道过滤
      if (channelFilter !== 'all' && rel.channelType !== channelFilter) {
        return false;
      }

      return true;
    });
  }, [relations, search, roleFilter, channelFilter]);

  // 渠道统计
  const channelTypes = useMemo(() => {
    if (!relations) return [];
    const types = new Set(relations.map(r => r.channelType));
    return Array.from(types);
  }, [relations]);

  if (isLoading) {
    return (
      <Card>
        <div className="flex justify-center items-center h-64">
          <Spin size="large" />
        </div>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <Empty description="加载失败" />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* 筛选栏 */}
      <Card>
        <div className="flex gap-4 flex-wrap">
          <Input
            placeholder="搜索对端 ID 或名称"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 300 }}
            allowClear
          />

          <Select
            placeholder="筛选角色"
            value={roleFilter}
            onChange={setRoleFilter}
            style={{ width: 150 }}
            suffixIcon={<FilterOutlined />}
          >
            <Select.Option value="all">所有角色</Select.Option>
            <Select.Option value="owner">Owner</Select.Option>
            <Select.Option value="admin">Admin</Select.Option>
            <Select.Option value="member">Member</Select.Option>
            <Select.Option value="guest">Guest</Select.Option>
            <Select.Option value="anonymous">Anonymous</Select.Option>
          </Select>

          <Select
            placeholder="筛选渠道"
            value={channelFilter}
            onChange={setChannelFilter}
            style={{ width: 150 }}
          >
            <Select.Option value="all">所有渠道</Select.Option>
            {channelTypes.map(type => (
              <Select.Option key={type} value={type}>
                {type}
              </Select.Option>
            ))}
          </Select>

          <div className="ml-auto text-sm text-gray-500 flex items-center">
            共 {filtered.length} / {relations?.length || 0} 条
          </div>
        </div>
      </Card>

      {/* 关系列表 */}
      <List
        dataSource={filtered}
        locale={{ emptyText: '暂无数据' }}
        renderItem={(relation) => (
          <Card className="mb-4" hoverable>
            <div className="flex items-center justify-between">
              {/* 左侧：用户信息 */}
              <div className="flex items-center gap-4">
                <div className="text-2xl">
                  {relation.channelType === 'aun' && relation.peerId.includes('group') ? (
                    <TeamOutlined />
                  ) : (
                    <UserOutlined />
                  )}
                </div>

                <div>
                  <div className="text-lg font-medium">
                    {relation.peerName || relation.peerId}
                  </div>
                  <div className="text-sm text-gray-500 space-y-1">
                    <div className="font-mono">{relation.peerId}</div>
                    <div>渠道: {relation.channelType}</div>
                  </div>
                </div>
              </div>

              {/* 右侧：角色和操作 */}
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <Tag color={roleColors[relation.role]} className="text-sm">
                    {roleLabels[relation.role]}
                  </Tag>
                  <div className="text-xs text-gray-500 mt-1">
                    {relation.roleSource === 'agent' ? 'agent 级' : '关系级'}
                  </div>
                </div>

                <Link 
                  to={`/agents/${agentId}/relations/${encodeURIComponent(relation.peerKey)}`}
                >
                  <Button type="primary">详情</Button>
                </Link>
              </div>
            </div>
          </Card>
        )}
      />
    </div>
  );
}
```

---

### 4. Hooks 实现

```typescript
// src/hooks/useAgentRoles.ts
import useSWR from 'swr';
import { agentRolesAPI } from '@/utils/api';
import type { AgentRoles } from '@/types/roles';

export function useAgentRoles(agentId: string) {
  const { data, error, mutate } = useSWR<AgentRoles>(
    agentId ? `/agents/${agentId}/roles` : null,
    () => agentRolesAPI.get(agentId).then(res => res.data),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );

  const addRole = async (role: string, userId: string) => {
    await agentRolesAPI.addRole(agentId, role, userId);
    await mutate();
  };

  const removeRole = async (role: string, userId: string) => {
    await agentRolesAPI.removeRole(agentId, role, userId);
    await mutate();
  };

  return {
    roles: data,
    isLoading: !error && !data,
    isError: error,
    addRole,
    removeRole,
    refresh: mutate,
  };
}

// src/hooks/useRelations.ts
import useSWR from 'swr';
import { relationsAPI } from '@/utils/api';
import type { Relation } from '@/types/roles';

export function useRelations(agentId: string) {
  const { data, error, mutate } = useSWR<Relation[]>(
    agentId ? `/agents/${agentId}/relations` : null,
    () => relationsAPI.list(agentId).then(res => res.data),
    {
      revalidateOnFocus: false,
    }
  );

  return {
    relations: data,
    isLoading: !error && !data,
    isError: error,
    refresh: mutate,
  };
}
```

---

## 样式指南

### Tailwind CSS 配置

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: '#1890ff',
        danger: '#ff4d4f',
      },
    },
  },
};
```

### 常用样式类

```css
/* 间距 */
.space-y-4 > * + * { margin-top: 1rem; }
.space-y-6 > * + * { margin-top: 1.5rem; }

/* 布局 */
.flex { display: flex; }
.gap-2 { gap: 0.5rem; }
.gap-4 { gap: 1rem; }

/* 文本 */
.text-sm { font-size: 0.875rem; }
.text-lg { font-size: 1.125rem; }
.font-mono { font-family: monospace; }
```

---

## 状态管理

### SWR 配置

```typescript
// src/lib/swr-config.ts
import { SWRConfig } from 'swr';

export const swrConfig = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
  dedupingInterval: 5000,
};

// App.tsx
<SWRConfig value={swrConfig}>
  <App />
</SWRConfig>
```

---

## 测试用例

### 组件测试

```typescript
// tests/components/RoleSection.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoleSection } from '@/components/RoleSection';

describe('RoleSection', () => {
  const mockOnAdd = jest.fn();
  const mockOnRemove = jest.fn();

  beforeEach(() => {
    mockOnAdd.mockClear();
    mockOnRemove.mockClear();
  });

  it('should render users list', () => {
    render(
      <RoleSection
        role="owner"
        title="Owners"
        description="Full control"
        permissions={['Manage roles']}
        users={['alice.aid.pub']}
        onAdd={mockOnAdd}
        onRemove={mockOnRemove}
      />
    );

    expect(screen.getByText('alice.aid.pub')).toBeInTheDocument();
  });

  it('should add a new user', async () => {
    mockOnAdd.mockResolvedValue(undefined);

    render(
      <RoleSection
        role="owner"
        title="Owners"
        description="Full control"
        permissions={['Manage roles']}
        users={[]}
        onAdd={mockOnAdd}
        onRemove={mockOnRemove}
      />
    );

    // 点击添加按钮
    fireEvent.click(screen.getByText(/添加/));

    // 输入 AID
    const input = screen.getByPlaceholderText(/输入 AID/);
    fireEvent.change(input, { target: { value: 'bob.aid.pub' } });

    // 确认
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => {
      expect(mockOnAdd).toHaveBeenCalledWith('bob.aid.pub');
    });
  });

  it('should validate AID format', async () => {
    render(
      <RoleSection
        role="owner"
        title="Owners"
        description="Full control"
        permissions={['Manage roles']}
        users={[]}
        onAdd={mockOnAdd}
        onRemove={mockOnRemove}
      />
    );

    fireEvent.click(screen.getByText(/添加/));

    const input = screen.getByPlaceholderText(/输入 AID/);
    fireEvent.change(input, { target: { value: 'invalid-id' } });
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => {
      expect(screen.getByText(/无效的 AID 格式/)).toBeInTheDocument();
    });

    expect(mockOnAdd).not.toHaveBeenCalled();
  });
});
```

---

**文档维护**: Claude (Opus 4.8)  
**创建日期**: 2026-06-24  
**最后更新**: 2026-06-24
