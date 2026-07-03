/**
 * CLI 权限类型定义
 *
 * 用于 ecweb 角色管理中的命令权限配置
 */

// Tab 分类定义
export const CLI_PERMISSION_TABS = [
  {
    key: 'relation',
    label: '关系管理',
    icon: 'UsergroupAddOutlined',
    description: '对端关系、配置读写相关命令',
    color: '#1890ff',
  },
  {
    key: 'role',
    label: '角色管理',
    icon: 'SafetyOutlined',
    description: '角色定义、权限配置相关命令',
    color: '#52c41a',
  },
  {
    key: 'agent',
    label: 'Agent 管理',
    icon: 'RobotOutlined',
    description: 'Agent 配置、生命周期相关命令',
    color: '#faad14',
  },
  {
    key: 'process',
    label: '进程管理',
    icon: 'ClusterOutlined',
    description: '进程配置、运行控制相关命令',
    color: '#722ed1',
  },
  {
    key: 'filesystem',
    label: '文件系统',
    icon: 'FolderOutlined',
    description: '文件读写、路径访问相关命令',
    color: '#13c2c2',
  },
  {
    key: 'control',
    label: '控制命令',
    icon: 'ControlOutlined',
    description: '系统控制、运行时管理相关命令',
    color: '#eb2f96',
  },
  {
    key: 'raw-cli',
    label: '原始 CLI',
    icon: 'CodeOutlined',
    description: '直接执行 shell 命令',
    color: '#fa541c',
    dangerous: true,
  },
] as const;

export type CliPermissionScope = typeof CLI_PERMISSION_TABS[number]['key'];

// 命令操作定义（从 operation-registry 获取）
export interface OperationDefinition {
  operation: string;           // 如 "relation:read"
  namespace: string;           // 如 "relation"
  category: string;            // 如 "relation"
  description: string;
  dangerous?: boolean;
  scopes: string[];           // ['relation']
}

// 角色的命令权限配置
export interface RoleCommandPermissions {
  [rule: string]: CommandPermission;  // rule 可以是具体命令、通配符或类别
}

export interface CommandPermission {
  allow: boolean;              // 是否允许执行
  dangerous?: boolean;         // 是否标记为危险操作
  scopes?: CliPermissionScope[];  // 适用范围
  reason?: string;             // 权限说明
  constraints?: CommandPermissionConstraints;
}

export interface CommandPermissionConstraints {
  // 布尔约束
  ownPeerOnly?: boolean;          // 仅限自己的对端
  ownAgentOnly?: boolean;         // 仅限自己的 agent
  privateOnly?: boolean;          // 仅限私聊
  groupOnly?: boolean;            // 仅限群组
  requireDaemonOwner?: boolean;   // 需要守护进程所有者
  requireControlChannel?: boolean; // 需要控制通道
  requireExplicitDangerousGrant?: boolean;  // 需要显式危险授权

  // 字符串约束
  requireFieldOverride?: string;  // 需要字段覆盖
  cwdPolicy?: 'agentProject' | 'evolclawHome' | 'none';  // 工作目录策略

  // 数组约束
  forbiddenFlags?: string[];      // 禁用的标志
  allowedConfigKeys?: string[];   // 允许的配置键
  allowedPrefixes?: string[];     // 允许的前缀
  envAllowlist?: string[];        // 环境变量白名单

  // 映射约束
  allowedArgs?: Record<string, Array<string | number | boolean>>;  // 允许的参数值
  deniedArgs?: Record<string, Array<string | number | boolean>>;   // 拒绝的参数值

  // 数值约束
  timeoutMs?: number;             // 超时时间（毫秒）
  outputLimitBytes?: number;      // 输出限制（字节）
}

// 按 scope 分组的命令
export interface GroupedOperations {
  [scope: string]: OperationDefinition[];
}

// 命令权限编辑表单数据
export interface CommandPermissionFormData extends CommandPermission {
  operation: string;  // 命令操作名
}

// 约束条件显示配置
export const CONSTRAINT_LABELS: Record<keyof CommandPermissionConstraints, string> = {
  ownPeerOnly: '仅限自己的对端',
  ownAgentOnly: '仅限自己的 Agent',
  privateOnly: '仅限私聊',
  groupOnly: '仅限群组',
  requireDaemonOwner: '需要守护进程所有者',
  requireControlChannel: '需要控制通道',
  requireExplicitDangerousGrant: '需要显式危险授权',
  requireFieldOverride: '需要字段覆盖',
  cwdPolicy: '工作目录策略',
  forbiddenFlags: '禁用的标志',
  allowedConfigKeys: '允许的配置键',
  allowedPrefixes: '允许的前缀',
  envAllowlist: '环境变量白名单',
  allowedArgs: '允许的参数值',
  deniedArgs: '拒绝的参数值',
  timeoutMs: '超时时间',
  outputLimitBytes: '输出限制',
};

export const CONSTRAINT_DESCRIPTIONS: Partial<Record<keyof CommandPermissionConstraints, string>> = {
  ownPeerOnly: '命令只能操作自己相关的对端',
  ownAgentOnly: '命令只能操作自己的 Agent',
  privateOnly: '命令只能在私聊会话中使用',
  groupOnly: '命令只能在群组会话中使用',
  requireDaemonOwner: '需要是守护进程所有者才能执行',
  requireControlChannel: '需要通过控制通道发起命令',
  requireExplicitDangerousGrant: '危险操作需要显式授权',
  cwdPolicy: '限制命令的工作目录',
  timeoutMs: '命令执行的最大时间限制',
  outputLimitBytes: '命令输出的最大字节数限制',
};
