import React from 'react';
import {
  Modal,
  Form,
  Switch,
  Input,
  Select,
  InputNumber,
  Checkbox,
  Space,
  Divider,
  Alert,
  Collapse
} from 'antd';
import {
  WarningOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import type {
  CommandPermission,
  CommandPermissionFormData
} from '@/types/cli-permissions';

interface CommandPermissionModalProps {
  open: boolean;
  operation: string;
  initialValues?: CommandPermission;
  onOk: (values: CommandPermission) => Promise<void>;
  onCancel: () => void;
}

/**
 * 命令权限编辑对话框
 *
 * 功能：
 * 1. 基本设置：允许/禁止、危险标记、说明
 * 2. 访问约束：布尔开关
 * 3. 参数约束：配置键、工作目录策略
 * 4. 执行限制：超时、输出限制
 */
export function CommandPermissionModal({
  open,
  operation,
  initialValues,
  onOk,
  onCancel,
}: CommandPermissionModalProps) {
  const [form] = Form.useForm();
  const [isDangerous, setIsDangerous] = React.useState(initialValues?.dangerous || false);
  const [isAllowed, setIsAllowed] = React.useState(initialValues?.allow ?? true);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      await onOk(values);
      form.resetFields();
    } catch (error) {
      console.error('表单验证失败:', error);
    }
  };

  return (
    <Modal
      title={
        <Space>
          <span>编辑命令权限</span>
          <code style={{ fontSize: '0.9em', color: '#1890ff' }}>{operation}</code>
        </Space>
      }
      open={open}
      onOk={handleSubmit}
      onCancel={onCancel}
      width={700}
      okText="保存"
      cancelText="取消"
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues || { allow: true }}
        onValuesChange={(changed) => {
          if ('dangerous' in changed) setIsDangerous(changed.dangerous);
          if ('allow' in changed) setIsAllowed(changed.allow);
        }}
      >
        {/* 危险操作警告 */}
        {isDangerous && (
          <Alert
            message="危险操作"
            description="此命令被标记为危险操作，请谨慎配置权限和约束条件"
            type="warning"
            icon={<WarningOutlined />}
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        {/* 基本设置 */}
        <div style={{ marginBottom: 24 }}>
          <h4 style={{ marginBottom: 16 }}>基本设置</h4>

          <Form.Item
            name="allow"
            label="允许执行"
            valuePropName="checked"
            tooltip="控制此命令是否可以被执行"
          >
            <Switch
              checkedChildren="允许"
              unCheckedChildren="禁止"
            />
          </Form.Item>

          <Form.Item
            name="dangerous"
            label="标记为危险操作"
            valuePropName="checked"
            tooltip="标记此命令为危险操作，用户执行时会看到警告"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="reason"
            label="权限说明"
            tooltip="解释为什么设置此权限，特别是禁止时"
          >
            <Input.TextArea
              rows={2}
              placeholder="例如：管理员不允许删除关系，需要 Owner 权限"
              maxLength={200}
              showCount
            />
          </Form.Item>
        </div>

        <Divider />

        {/* 访问约束 */}
        <div style={{ marginBottom: 24 }}>
          <h4 style={{ marginBottom: 16 }}>访问约束</h4>

          <Space direction="vertical" style={{ width: '100%' }}>
            <Form.Item
              name={['constraints', 'ownPeerOnly']}
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                仅限自己的对端 <code>ownPeerOnly</code>
                <div style={{ fontSize: '0.85em', color: '#999', marginLeft: 24 }}>
                  命令只能操作与自己相关的对端关系
                </div>
              </Checkbox>
            </Form.Item>

            <Form.Item
              name={['constraints', 'ownAgentOnly']}
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                仅限自己的 Agent <code>ownAgentOnly</code>
                <div style={{ fontSize: '0.85em', color: '#999', marginLeft: 24 }}>
                  命令只能操作自己创建或拥有的 Agent
                </div>
              </Checkbox>
            </Form.Item>

            <Form.Item
              name={['constraints', 'privateOnly']}
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                仅限私聊 <code>privateOnly</code>
                <div style={{ fontSize: '0.85em', color: '#999', marginLeft: 24 }}>
                  命令只能在私聊会话中使用
                </div>
              </Checkbox>
            </Form.Item>

            <Form.Item
              name={['constraints', 'groupOnly']}
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                仅限群组 <code>groupOnly</code>
                <div style={{ fontSize: '0.85em', color: '#999', marginLeft: 24 }}>
                  命令只能在群组会话中使用
                </div>
              </Checkbox>
            </Form.Item>

            <Form.Item
              name={['constraints', 'requireControlChannel']}
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                需要控制通道 <code>requireControlChannel</code>
                <div style={{ fontSize: '0.85em', color: '#999', marginLeft: 24 }}>
                  命令必须通过控制通道发起
                </div>
              </Checkbox>
            </Form.Item>

            <Form.Item
              name={['constraints', 'requireDaemonOwner']}
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                需要守护进程所有者 <code>requireDaemonOwner</code>
                <div style={{ fontSize: '0.85em', color: '#999', marginLeft: 24 }}>
                  命令需要守护进程所有者权限
                </div>
              </Checkbox>
            </Form.Item>

            <Form.Item
              name={['constraints', 'requireExplicitDangerousGrant']}
              valuePropName="checked"
              noStyle
            >
              <Checkbox>
                需要显式危险授权 <code>requireExplicitDangerousGrant</code>
                <div style={{ fontSize: '0.85em', color: '#999', marginLeft: 24 }}>
                  用户必须显式确认才能执行此危险操作
                </div>
              </Checkbox>
            </Form.Item>
          </Space>
        </div>

        <Divider />

        {/* 参数约束 */}
        <Collapse
          defaultActiveKey={[]}
          ghost
          items={[
            {
              key: 'params',
              label: <h4 style={{ margin: 0 }}>参数约束（高级）</h4>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Form.Item
                    name={['constraints', 'allowedConfigKeys']}
                    label="允许的配置键"
                    tooltip="限制用户可以修改的配置项"
                  >
                    <Select
                      mode="tags"
                      placeholder="输入允许修改的配置键，如 model, dispatch"
                      options={[
                        { value: 'model', label: 'model' },
                        { value: 'dispatch', label: 'dispatch' },
                        { value: 'chatmode', label: 'chatmode' },
                        { value: 'permissionMode', label: 'permissionMode' },
                      ]}
                    />
                  </Form.Item>

                  <Form.Item
                    name={['constraints', 'forbiddenFlags']}
                    label="禁用的标志"
                    tooltip="禁止使用的命令行标志"
                  >
                    <Select
                      mode="tags"
                      placeholder="输入禁用的标志，如 --force, --recursive"
                    />
                  </Form.Item>

                  <Form.Item
                    name={['constraints', 'allowedPrefixes']}
                    label="允许的路径前缀"
                    tooltip="限制可访问的文件路径前缀"
                  >
                    <Select
                      mode="tags"
                      placeholder="例如：.evolclaw/, data/, logs/"
                    />
                  </Form.Item>

                  <Form.Item
                    name={['constraints', 'cwdPolicy']}
                    label="工作目录策略"
                    tooltip="限制命令的工作目录范围"
                  >
                    <Select placeholder="选择工作目录策略">
                      <Select.Option value="agentProject">
                        agentProject - Agent 项目目录
                      </Select.Option>
                      <Select.Option value="evolclawHome">
                        evolclawHome - EvolClaw 主目录
                      </Select.Option>
                      <Select.Option value="none">
                        none - 不限制
                      </Select.Option>
                    </Select>
                  </Form.Item>

                  <Form.Item
                    name={['constraints', 'envAllowlist']}
                    label="环境变量白名单"
                    tooltip="允许访问的环境变量"
                  >
                    <Select
                      mode="tags"
                      placeholder="输入允许的环境变量名，如 PATH, HOME"
                    />
                  </Form.Item>
                </Space>
              ),
            },
          ]}
        />

        <Divider />

        {/* 执行限制 */}
        <div style={{ marginBottom: 24 }}>
          <h4 style={{ marginBottom: 16 }}>执行限制</h4>

          <Form.Item
            name={['constraints', 'timeoutMs']}
            label="超时时间（毫秒）"
            tooltip="命令执行的最大时间，超时将被终止"
          >
            <InputNumber
              min={0}
              step={1000}
              style={{ width: '100%' }}
              placeholder="例如：30000 (30秒)"
              addonAfter="ms"
            />
          </Form.Item>

          <Form.Item
            name={['constraints', 'outputLimitBytes']}
            label="输出限制（字节）"
            tooltip="命令输出的最大字节数，超出将被截断"
          >
            <InputNumber
              min={0}
              step={1024}
              style={{ width: '100%' }}
              placeholder="例如：1048576 (1MB)"
              addonAfter="bytes"
              formatter={value => value ? `${Math.round(Number(value) / 1024)}KB` : ''}
              parser={value => {
                const match = value?.match(/(\d+)/);
                return match ? Number(match[1]) * 1024 : 0;
              }}
            />
          </Form.Item>
        </div>

        {/* 提示信息 */}
        {!isAllowed && (
          <Alert
            message="提示"
            description={'禁止执行时，建议在“权限说明”中解释原因，帮助用户理解限制'}
            type="info"
            icon={<InfoCircleOutlined />}
            showIcon
            style={{ marginTop: 16 }}
          />
        )}
      </Form>
    </Modal>
  );
}
