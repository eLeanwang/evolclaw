import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  PageHeader,
  Card,
  Spin,
  message,
  Button,
  Space,
  Descriptions,
  Tag
} from 'antd';
import {
  ArrowLeftOutlined,
  SaveOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import { CliPermissionTabs } from '@/components/CliPermissionTabs';
import type {
  OperationDefinition,
  RoleCommandPermissions,
  CommandPermission
} from '@/types/cli-permissions';

/**
 * 角色命令权限配置页面
 *
 * 路由: /roles/:roleName/command-permissions
 *
 * 功能：
 * 1. 按 Tab 分类展示 CLI 命令权限
 * 2. 配置每个命令的允许/禁止状态
 * 3. 设置命令执行的约束条件
 * 4. 实时保存和 WebSocket 更新
 */
export default function RoleCommandPermissionsPage() {
  const { roleName } = useParams<{ roleName: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [operations, setOperations] = useState<OperationDefinition[]>([]);
  const [permissions, setPermissions] = useState<RoleCommandPermissions>({});
  const [roleInfo, setRoleInfo] = useState<any>(null);

  // 加载数据
  useEffect(() => {
    loadData();
  }, [roleName]);

  // WebSocket 实时更新
  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        source: 'roleDefinitions'
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.kind === 'roleDefinitions' && data.roles?.[roleName!]) {
        setPermissions(data.roles[roleName!].commandPermissions || {});
      }
    };

    return () => ws.close();
  }, [roleName]);

  const loadData = async () => {
    try {
      setLoading(true);

      // 加载所有命令操作
      const opsRes = await fetch('/api/role-definitions/operations');
      const opsData = await opsRes.json();
      setOperations(opsData.operations || []);

      // 加载角色定义
      const roleRes = await fetch(`/api/role-definitions/${roleName}`);
      if (!roleRes.ok) {
        throw new Error('角色不存在');
      }
      const roleData = await roleRes.json();
      setRoleInfo(roleData);
      setPermissions(roleData.commandPermissions || {});
    } catch (error: any) {
      message.error(`加载失败: ${error.message}`);
      navigate('/roles');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePermission = async (
    operation: string,
    permission: CommandPermission
  ) => {
    try {
      setSaving(true);

      const updated = {
        ...permissions,
        [operation]: permission,
      };

      const response = await fetch(`/api/role-definitions/${roleName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandPermissions: updated,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || '更新失败');
      }

      setPermissions(updated);
      message.success('权限已更新');
    } catch (error: any) {
      message.error(`更新失败: ${error.message}`);
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePermission = async (operation: string) => {
    try {
      setSaving(true);

      const updated = { ...permissions };
      delete updated[operation];

      const response = await fetch(`/api/role-definitions/${roleName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandPermissions: updated,
        }),
      });

      if (!response.ok) {
        throw new Error('删除失败');
      }

      setPermissions(updated);
      message.success('权限已删除');
    } catch (error: any) {
      message.error(`删除失败: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReload = () => {
    loadData();
    message.info('已刷新数据');
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  const permissionCount = Object.keys(permissions).length;
  const allowedCount = Object.values(permissions).filter(p => p.allow).length;
  const deniedCount = permissionCount - allowedCount;

  return (
    <div className="role-command-permissions-page">
      <PageHeader
        onBack={() => navigate(`/roles/${roleName}`)}
        backIcon={<ArrowLeftOutlined />}
        title={`命令权限配置: ${roleName}`}
        subTitle={roleInfo?.description}
        extra={[
          <Button
            key="reload"
            icon={<ReloadOutlined />}
            onClick={handleReload}
          >
            刷新
          </Button>,
        ]}
      >
        <Descriptions size="small" column={3}>
          <Descriptions.Item label="角色名称">
            <Tag color="blue">{roleName}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="配置的权限">
            <Space>
              <Tag color="green">{allowedCount} 允许</Tag>
              <Tag color="red">{deniedCount} 禁止</Tag>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="可用命令">
            {operations.length} 个
          </Descriptions.Item>
        </Descriptions>
      </PageHeader>

      <div style={{ padding: '24px' }}>
        <Card>
          {/* 使用说明 */}
          <div style={{
            marginBottom: 24,
            padding: 16,
            background: '#f0f5ff',
            border: '1px solid #adc6ff',
            borderRadius: 4
          }}>
            <h4 style={{ marginBottom: 8 }}>使用说明</h4>
            <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
              <li>命令按功能分类显示在不同 Tab 中</li>
              <li>使用开关快速允许/禁止命令执行</li>
              <li>点击"编辑"配置详细的约束条件</li>
              <li>配置会自动保存并实时同步</li>
            </ul>
          </div>

          {/* Tab 分类权限列表 */}
          <CliPermissionTabs
            roleName={roleName!}
            operations={operations}
            permissions={permissions}
            onUpdatePermission={handleUpdatePermission}
            onDeletePermission={handleDeletePermission}
            readonly={saving}
          />
        </Card>
      </div>
    </div>
  );
}
