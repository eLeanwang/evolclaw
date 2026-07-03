import React, { useState } from 'react';
import { List, Switch, Tag, Button, Space, Tooltip, Modal } from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  WarningOutlined,
  LockOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import type {
  OperationDefinition,
  RoleCommandPermissions,
  CommandPermission,
  CliPermissionScope
} from '@/types/cli-permissions';
import { CONSTRAINT_LABELS } from '@/types/cli-permissions';
import { CommandPermissionModal } from './CommandPermissionModal';

interface CommandPermissionListProps {
  scope: CliPermissionScope;
  operations: OperationDefinition[];
  permissions: RoleCommandPermissions;
  onUpdatePermission: (operation: string, permission: any) => Promise<void>;
  onDeletePermission: (operation: string) => Promise<void>;
  readonly?: boolean;
}

/**
 * 命令权限列表组件
 *
 * 显示某个 scope 下的所有命令及其权限配置
 */
export function CommandPermissionList({
  scope,
  operations,
  permissions,
  onUpdatePermission,
  onDeletePermission,
  readonly = false,
}: CommandPermissionListProps) {

  const [editingOperation, setEditingOperation] = useState<string | null>(null);
  const [editingPermission, setEditingPermission] = useState<CommandPermission | undefined>(undefined);

  // 获取命令的权限配置（支持通配符匹配）
  const getPermissionForOperation = (operation: string): CommandPermission | undefined => {
    // 1. 精确匹配
    if (permissions[operation]) {
      return permissions[operation];
    }

    // 2. 通配符匹配（如 relation:*）
    const namespace = operation.split(':')[0];
    if (permissions[`${namespace}:*`]) {
      return permissions[`${namespace}:*`];
    }

    // 3. 类别通配符（如 relation）
    if (permissions[namespace]) {
      return permissions[namespace];
    }

    // 4. 全局通配符
    if (permissions['*']) {
      return permissions['*'];
    }

    return undefined;
  };

  // 快速切换允许/禁止
  const handleToggleAllow = async (operation: string, currentAllow: boolean) => {
    const currentPerm = getPermissionForOperation(operation);
    await onUpdatePermission(operation, {
      ...currentPerm,
      allow: !currentAllow,
    });
  };

  // 打开编辑对话框
  const handleEdit = (operation: string) => {
    const perm = getPermissionForOperation(operation);
    setEditingOperation(operation);
    setEditingPermission(perm);
  };

  // 保存编辑
  const handleSaveEdit = async (permission: CommandPermission) => {
    if (!editingOperation) return;
    await onUpdatePermission(editingOperation, permission);
    setEditingOperation(null);
    setEditingPermission(undefined);
  };

  // 删除确认
  const handleDelete = (operation: string) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定要删除命令 ${operation} 的权限配置吗？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => onDeletePermission(operation),
    });
  };

  // 渲染约束条件标签
  const renderConstraints = (constraints?: CommandPermission['constraints']) => {
    if (!constraints) return null;

    const tags: React.ReactNode[] = [];

    // 布尔约束
    Object.entries(constraints).forEach(([key, value]) => {
      if (typeof value === 'boolean' && value) {
        tags.push(
          <Tag key={key} color="blue" style={{ fontSize: '0.85em' }}>
            {CONSTRAINT_LABELS[key as keyof typeof CONSTRAINT_LABELS] || key}
          </Tag>
        );
      }
    });

    // 特殊约束显示
    if (constraints.timeoutMs) {
      tags.push(
        <Tag key="timeout" color="orange" style={{ fontSize: '0.85em' }}>
          超时: {constraints.timeoutMs}ms
        </Tag>
      );
    }

    if (constraints.outputLimitBytes) {
      tags.push(
        <Tag key="outputLimit" color="orange" style={{ fontSize: '0.85em' }}>
          输出限制: {Math.round(constraints.outputLimitBytes / 1024)}KB
        </Tag>
      );
    }

    if (constraints.cwdPolicy) {
      tags.push(
        <Tag key="cwdPolicy" color="purple" style={{ fontSize: '0.85em' }}>
          工作目录: {constraints.cwdPolicy}
        </Tag>
      );
    }

    return tags.length > 0 ? (
      <div style={{ marginTop: 8 }}>
        <Space size={4} wrap>
          {tags}
        </Space>
      </div>
    ) : null;
  };

  return (
    <>
      <List
        dataSource={operations}
        renderItem={(op) => {
          const permission = getPermissionForOperation(op.operation);
          const isAllowed = permission?.allow ?? false;
          const isDangerous = permission?.dangerous || op.dangerous;

          return (
            <List.Item
              key={op.operation}
              actions={[
                <Tooltip title={readonly ? '只读模式' : (isAllowed ? '禁止' : '允许')}>
                  <Switch
                    checked={isAllowed}
                    onChange={() => handleToggleAllow(op.operation, isAllowed)}
                    disabled={readonly}
                    checkedChildren="允许"
                    unCheckedChildren="禁止"
                  />
                </Tooltip>,
                <Button
                  type="link"
                  icon={<EditOutlined />}
                  onClick={() => handleEdit(op.operation)}
                  disabled={readonly}
                >
                  编辑
                </Button>,
                permission && (
                  <Button
                    type="link"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => handleDelete(op.operation)}
                    disabled={readonly}
                  >
                    删除
                  </Button>
                ),
              ].filter(Boolean)}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <code style={{
                      fontSize: '0.95em',
                      fontWeight: 500,
                      color: isAllowed ? '#52c41a' : '#999'
                    }}>
                      {op.operation}
                    </code>
                    {isDangerous && (
                      <Tooltip title="危险操作">
                        <Tag icon={<WarningOutlined />} color="error">
                          危险
                        </Tag>
                      </Tooltip>
                    )}
                    {permission && !isAllowed && permission.reason && (
                      <Tooltip title={permission.reason}>
                        <InfoCircleOutlined style={{ color: '#1890ff' }} />
                      </Tooltip>
                    )}
                  </Space>
                }
                description={
                  <div>
                    <div style={{ color: '#666', fontSize: '0.9em' }}>
                      {op.description}
                    </div>
                    {permission && renderConstraints(permission.constraints)}
                    {permission?.reason && !isAllowed && (
                      <div style={{
                        marginTop: 8,
                        padding: '4px 8px',
                        background: '#fff7e6',
                        border: '1px solid #ffd591',
                        borderRadius: 4,
                        fontSize: '0.85em',
                        color: '#d46b08'
                      }}>
                        <LockOutlined /> {permission.reason}
                      </div>
                    )}
                  </div>
                }
              />
            </List.Item>
          );
        }}
      />

      {/* 编辑对话框 */}
      <CommandPermissionModal
        open={!!editingOperation}
        operation={editingOperation || ''}
        initialValues={editingPermission}
        onOk={handleSaveEdit}
        onCancel={() => {
          setEditingOperation(null);
          setEditingPermission(undefined);
        }}
      />
    </>
  );
}
