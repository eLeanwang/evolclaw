import React, { useMemo } from 'react';
import { Tabs, Card, Empty } from 'antd';
import type { TabsProps } from 'antd';
import { CLI_PERMISSION_TABS } from '@/types/cli-permissions';
import { CommandPermissionList } from './CommandPermissionList';
import type {
  OperationDefinition,
  RoleCommandPermissions,
  CliPermissionScope
} from '@/types/cli-permissions';

interface CliPermissionTabsProps {
  roleName: string;
  operations: OperationDefinition[];  // 所有可用的命令操作
  permissions: RoleCommandPermissions;  // 当前角色的权限配置
  onUpdatePermission: (operation: string, permission: any) => Promise<void>;
  onDeletePermission: (operation: string) => Promise<void>;
  readonly?: boolean;
}

/**
 * CLI 权限分 Tab 管理组件
 *
 * 按 scope 分类展示命令权限，每个 Tab 显示对应类别的命令
 */
export function CliPermissionTabs({
  roleName,
  operations,
  permissions,
  onUpdatePermission,
  onDeletePermission,
  readonly = false,
}: CliPermissionTabsProps) {

  // 按 scope 分组命令
  const groupedOperations = useMemo(() => {
    const groups: Record<string, OperationDefinition[]> = {};

    operations.forEach(op => {
      // 一个命令可能属于多个 scope
      op.scopes.forEach(scope => {
        if (!groups[scope]) {
          groups[scope] = [];
        }
        // 避免重复
        if (!groups[scope].find(existing => existing.operation === op.operation)) {
          groups[scope].push(op);
        }
      });
    });

    return groups;
  }, [operations]);

  // 统计每个 Tab 下的命令数量
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    CLI_PERMISSION_TABS.forEach(tab => {
      counts[tab.key] = groupedOperations[tab.key]?.length || 0;
    });
    return counts;
  }, [groupedOperations]);

  // 构建 Tabs 配置
  const tabItems: TabsProps['items'] = CLI_PERMISSION_TABS.map(tab => ({
    key: tab.key,
    label: (
      <span>
        {tab.label}
        <span style={{
          marginLeft: 8,
          fontSize: '0.85em',
          color: '#999'
        }}>
          ({tabCounts[tab.key]})
        </span>
      </span>
    ),
    children: (
      <Card
        bordered={false}
        style={{ minHeight: 400 }}
      >
        {/* Tab 描述 */}
        <div style={{
          marginBottom: 16,
          padding: 12,
          background: '#f5f5f5',
          borderRadius: 4,
          borderLeft: `3px solid ${tab.color}`
        }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {tab.label}
            {tab.dangerous && (
              <span style={{
                marginLeft: 8,
                color: '#ff4d4f',
                fontSize: '0.9em'
              }}>
                ⚠️ 危险类别
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.9em', color: '#666' }}>
            {tab.description}
          </div>
        </div>

        {/* 命令列表 */}
        {groupedOperations[tab.key]?.length > 0 ? (
          <CommandPermissionList
            scope={tab.key as CliPermissionScope}
            operations={groupedOperations[tab.key]}
            permissions={permissions}
            onUpdatePermission={onUpdatePermission}
            onDeletePermission={onDeletePermission}
            readonly={readonly}
          />
        ) : (
          <Empty
            description={`暂无 ${tab.label} 相关命令`}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        )}
      </Card>
    ),
  }));

  return (
    <div className="cli-permission-tabs">
      <Tabs
        defaultActiveKey="relation"
        items={tabItems}
        type="card"
        size="large"
      />
    </div>
  );
}
