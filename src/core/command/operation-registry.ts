import type { OperationMeta, CommandScope, OperationCategory } from '../../types.js';

const CONFIG_MANAGEMENT_OPERATIONS: OperationMeta[] = ([
  ['config.show', 'Read one raw config layer', ['relation', 'agent', 'process']],
  ['config.effective', 'Read effective config with sources', ['relation', 'agent', 'process']],
  ['config.fields', 'List config schema fields', ['relation', 'agent', 'process']],
  ['config.validate', 'Validate a config layer', ['relation', 'agent', 'process']],
  ['config.init', 'Initialize a config layer', ['relation', 'agent', 'process']],
  ['config.list', 'List all config files', ['process']],
  ['config.snapshot', 'Create a config snapshot', ['process']],
  ['config.prune', 'Prune config snapshots', ['process']],
  ['config.history', 'List config snapshots', ['process']],
  ['config.diff', 'Compare config snapshots', ['process']],
  ['config.restore', 'Restore a config snapshot', ['process']],
  ['config.current', 'Read the selected config snapshot', ['process']],
  ['config.boots', 'Read config boot history', ['process']],
] as Array<[string, string, CommandScope[]]>).map(([id, description, defaultScopes]) => ({
  id,
  category: 'dangerous',
  dangerous: true,
  defaultScopes,
  description,
  sources: ['menu.cli', 'agent-tool', 'control'],
}));

/**
 * Operation Registry - 所有命令操作的元数据定义
 *
 * 参照设计文档 docs/command-execution-role-permission-design.md 第 5 节
 */

const OPERATIONS: OperationMeta[] = [
  // ── Model Operations ──
  {
    id: 'model.list',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation', 'role', 'agent'],
    description: '列出可用模型',
    sources: ['slash', 'menu', 'menu.cli'],
  },
  {
    id: 'model.current',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation', 'role', 'agent'],
    description: '查询当前使用的模型',
    sources: ['slash', 'menu', 'menu.cli'],
  },
  {
    id: 'model.info',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation', 'role', 'agent'],
    description: '查询指定模型的详细信息',
    sources: ['menu.cli', 'agent-tool'],
  },
  {
    id: 'model.check',
    category: 'diagnose',
    dangerous: false,
    defaultScopes: ['agent'],
    description: '检查模型可用性（可能触发网关探测）',
    sources: ['menu.cli', 'agent-tool'],
  },
  {
    id: 'model.use',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'role', 'agent'],
    description: '切换使用的模型',
    sources: ['slash', 'menu', 'menu.cli'],
  },
  {
    id: 'model.effort',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'role', 'agent'],
    description: '设置推理努力度',
    sources: ['slash', 'menu', 'menu.cli'],
  },
  {
    id: 'model.reset',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'role', 'agent'],
    description: '重置模型配置到角色默认值',
    sources: ['menu.cli', 'agent-tool'],
  },

  // ── Session Operations ──
  {
    id: 'permission.current',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation'],
    description: 'Read current permission mode',
    sources: ['slash', 'menu'],
  },
  {
    id: 'permission.update',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation'],
    description: 'Update current relation permission mode',
    sources: ['slash', 'menu'],
  },
  {
    id: 'permission.answer',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation'],
    description: 'Answer an interactive permission request',
    sources: ['slash', 'menu'],
  },
  {
    id: 'chatmode.current',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: 'Read chat mode',
    sources: ['slash', 'menu'],
  },
  {
    id: 'chatmode.update',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: 'Update chat mode',
    sources: ['slash', 'menu'],
  },
  {
    id: 'dispatch.current',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: 'Read group dispatch mode',
    sources: ['slash', 'menu'],
  },
  {
    id: 'dispatch.update',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: 'Update group dispatch mode',
    sources: ['slash', 'menu'],
  },

  {
    id: 'session.list',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation'],
    description: '列出会话',
    sources: ['slash', 'menu'],
  },
  {
    id: 'session.create',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation'],
    description: '创建新会话',
    sources: ['slash', 'menu'],
  },
  {
    id: 'session.rename',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation'],
    description: '重命名会话',
    sources: ['slash', 'menu'],
  },
  {
    id: 'session.delete',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation'],
    description: '删除会话',
    sources: ['slash', 'menu'],
  },

  // ── File Operations ──
  {
    id: 'file.list',
    category: 'read',
    dangerous: false,
    defaultScopes: ['filesystem'],
    description: '列出文件（需路径沙箱检查）',
    sources: ['menu'],
  },
  {
    id: 'file.fetch',
    category: 'read',
    dangerous: false,
    defaultScopes: ['filesystem'],
    description: '获取文件内容（需路径沙箱检查）',
    sources: ['menu'],
  },

  // ── Trigger Operations ──
  {
    id: 'trigger.list',
    category: 'read',
    dangerous: false,
    defaultScopes: ['agent', 'relation'],
    description: '列出定时触发器',
    sources: ['slash', 'menu'],
  },
  {
    id: 'trigger.create',
    category: 'write-agent',
    dangerous: false,
    defaultScopes: ['agent'],
    description: '创建定时触发器',
    sources: ['slash', 'menu'],
  },
  {
    id: 'trigger.update',
    category: 'write-agent',
    dangerous: false,
    defaultScopes: ['agent'],
    description: '更新定时触发器',
    sources: ['slash', 'menu'],
  },
  {
    id: 'trigger.delete',
    category: 'write-agent',
    dangerous: true,
    defaultScopes: ['agent'],
    description: '删除定时触发器',
    sources: ['slash', 'menu'],
  },

  // Role Assignment Operations
  {
    id: 'role.assign',
    category: 'write-agent',
    dangerous: false,
    defaultScopes: ['agent'],
    description: 'Assign a scoped peer, group, or group-member role',
    sources: ['ecweb', 'control'],
  },
  {
    id: 'role.revoke',
    category: 'write-agent',
    dangerous: false,
    defaultScopes: ['agent'],
    description: 'Revoke a scoped peer, group, or group-member role assignment',
    sources: ['ecweb', 'control'],
  },
  {
    id: 'role.policy.read',
    category: 'read',
    dangerous: false,
    defaultScopes: ['agent'],
    description: 'Read role definitions, command permissions, default roles, and usage limits',
    sources: ['ecweb', 'control'],
  },
  {
    id: 'role.policy.write',
    category: 'write-agent',
    dangerous: true,
    defaultScopes: ['agent'],
    description: 'Modify role definitions, command permissions, default roles, or usage limits',
    sources: ['ecweb', 'control'],
  },

  // Agent Operations
  {
    id: 'agent.list',
    category: 'read',
    dangerous: false,
    defaultScopes: ['control'],
    description: '列出所有 agent（敏感信息）',
    sources: ['menu', 'menu.cli', 'control'],
  },
  {
    id: 'agent.show',
    category: 'read',
    dangerous: false,
    defaultScopes: ['control', 'agent'],
    description: '查看 agent 详情（敏感信息）',
    sources: ['menu', 'menu.cli', 'control'],
  },
  {
    id: 'agent.getConfig',
    category: 'read',
    dangerous: true,
    defaultScopes: ['control'],
    description: '获取 agent 配置（含凭证）',
    sources: ['menu', 'menu.cli', 'control'],
  },
  {
    id: 'agent.create',
    category: 'process',
    dangerous: true,
    defaultScopes: ['control'],
    description: '创建新 agent',
    sources: ['menu', 'menu.cli', 'control'],
  },
  {
    id: 'agent.reload',
    category: 'process',
    dangerous: true,
    defaultScopes: ['control', 'agent'],
    description: '重载 agent 配置',
    sources: ['slash', 'menu', 'control'],
  },
  {
    id: 'agent.delete',
    category: 'dangerous',
    dangerous: true,
    defaultScopes: ['control'],
    description: '删除 agent（危险操作）',
    sources: ['menu', 'menu.cli', 'control'],
  },

  // ── System Operations ──
  {
    id: 'system.status',
    category: 'read',
    dangerous: false,
    defaultScopes: ['process'],
    description: '查看系统状态（敏感信息）',
    sources: ['slash', 'menu', 'menu.cli'],
  },
  {
    id: 'system.restart',
    category: 'process',
    dangerous: true,
    defaultScopes: ['process'],
    description: '重启 daemon 进程',
    sources: ['slash', 'menu', 'control'],
  },
  {
    id: 'system.upgrade',
    category: 'process',
    dangerous: true,
    defaultScopes: ['process'],
    description: '升级 evolclaw 版本',
    sources: ['slash', 'menu', 'control'],
  },

  // ── Stats Operations ──
  {
    id: 'stats.summary',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation', 'control'],
    description: '查看使用统计摘要',
    sources: ['menu.cli'],
  },
  {
    id: 'stats.peers',
    category: 'read',
    dangerous: false,
    defaultScopes: ['control'],
    description: '查看对端统计',
    sources: ['menu.cli'],
  },
  {
    id: 'stats.groups',
    category: 'read',
    dangerous: false,
    defaultScopes: ['control'],
    description: '查看群组统计',
    sources: ['menu.cli'],
  },
  {
    id: 'stats.session',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation'],
    description: '查看指定会话统计',
    sources: ['menu.cli'],
  },
  {
    id: 'stats.context',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation'],
    description: '查看指定上下文统计',
    sources: ['menu.cli'],
  },
  {
    id: 'stats.sqlReadonly',
    category: 'dangerous',
    dangerous: true,
    defaultScopes: ['control', 'raw-cli'],
    description: '执行只读 SQL 查询（可绕过业务 API 枚举数据）',
    sources: ['menu.cli'],
  },
  {
    id: 'stats.rebuild',
    category: 'dangerous',
    dangerous: true,
    defaultScopes: ['process'],
    description: '重建统计数据库',
    sources: ['menu.cli'],
  },

  // ── AID Operations ──
  {
    id: 'aid.listLocal',
    category: 'read',
    dangerous: true,
    defaultScopes: ['control'],
    description: '列出本地 AID（敏感信息）',
    sources: ['menu.cli', 'control'],
  },
  {
    id: 'aid.showLocal',
    category: 'read',
    dangerous: true,
    defaultScopes: ['control'],
    description: '查看本地 AID 详情（敏感信息）',
    sources: ['menu.cli', 'control'],
  },
  {
    id: 'aid.lookupRemote',
    category: 'diagnose',
    dangerous: false,
    defaultScopes: ['control'],
    description: '查询远程 AID 信息（敏感信息）',
    sources: ['menu.cli', 'control'],
  },

  // ── Storage Operations ──
  {
    id: 'storage.list',
    category: 'read',
    dangerous: false,
    defaultScopes: ['control'],
    description: '列出存储对象（敏感信息）',
    sources: ['menu.cli', 'control'],
  },
  {
    id: 'storage.quota',
    category: 'read',
    dangerous: false,
    defaultScopes: ['control'],
    description: '查看存储配额（敏感信息）',
    sources: ['menu.cli', 'control'],
  },
  {
    id: 'storage.upload',
    category: 'write-agent',
    dangerous: true,
    defaultScopes: ['control'],
    description: '上传文件到云存储',
    sources: ['menu.cli', 'control'],
  },
  {
    id: 'storage.download',
    category: 'write-agent',
    dangerous: true,
    defaultScopes: ['control'],
    description: '从云存储下载文件',
    sources: ['menu.cli', 'control'],
  },
  {
    id: 'storage.delete',
    category: 'dangerous',
    dangerous: true,
    defaultScopes: ['control'],
    description: '删除云存储对象',
    sources: ['menu.cli', 'control'],
  },

  // ── Gateway & Config Operations ──
  {
    id: 'gateway.read',
    category: 'read',
    dangerous: true,
    defaultScopes: ['process'],
    description: '查询网关配置',
    sources: ['menu', 'control'],
  },
  {
    id: 'gateway.write',
    category: 'process',
    dangerous: true,
    defaultScopes: ['process'],
    description: '修改网关配置',
    sources: ['menu', 'control'],
  },
  {
    id: 'config.get',
    category: 'read',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: 'Read a relation or agent config field',
    sources: ['menu.cli', 'agent-tool'],
  },
  {
    id: 'config.set',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: 'Write a relation or agent config field',
    sources: ['menu.cli', 'agent-tool'],
  },
  {
    id: 'config.unset',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: 'Remove a relation or agent config field',
    sources: ['menu.cli', 'agent-tool'],
  },
  {
    id: 'config.read',
    category: 'read',
    dangerous: true,
    defaultScopes: ['relation', 'agent', 'process'],
    description: '查询配置',
    sources: ['menu', 'menu.cli', 'control'],
  },
  {
    id: 'config.write',
    category: 'process',
    dangerous: true,
    defaultScopes: ['relation', 'agent', 'process'],
    description: '修改配置',
    sources: ['menu', 'menu.cli', 'control'],
  },

  // ── EC Command Operations ──
  // agent 在会话内通过 Bash 工具调用 `ec msg|group|ctl send|file` 时触发。
  // 参照设计文档 docs/权限配置化与通用接口鉴权设计.md
  ...CONFIG_MANAGEMENT_OPERATIONS,
  {
    id: 'ec.msg.send',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: '通过 ec msg send 发送私聊消息',
    sources: ['agent-tool'],
  },
  {
    id: 'ec.msg.file',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: '通过 ec msg file 发送私聊文件',
    sources: ['agent-tool'],
  },
  {
    id: 'ec.group.send',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: '通过 ec group send 发送群组消息',
    sources: ['agent-tool'],
  },
  {
    id: 'ec.group.file',
    category: 'write-own',
    dangerous: false,
    defaultScopes: ['relation', 'agent'],
    description: '通过 ec group file 发送群组文件',
    sources: ['agent-tool'],
  },
  {
    id: 'ec.ctl.send',
    category: 'write-agent',
    dangerous: false,
    defaultScopes: ['control', 'agent'],
    description: '通过 ec ctl send 发送控制通道消息',
    sources: ['agent-tool'],
  },
  {
    id: 'ec.ctl.file',
    category: 'write-agent',
    dangerous: false,
    defaultScopes: ['control', 'agent'],
    description: '通过 ec ctl file 发送控制通道文件',
    sources: ['agent-tool'],
  },

  // ── Raw CLI & Shell Execution ──
  {
    id: 'cli.exec.raw',
    category: 'dangerous',
    dangerous: true,
    defaultScopes: ['raw-cli'],
    description: '原始 CLI 透传（无法归一化的命令）',
    sources: ['menu.cli'],
  },
  {
    id: 'shell.exec',
    category: 'dangerous',
    dangerous: true,
    defaultScopes: ['raw-cli'],
    description: 'Shell 命令执行（预留）',
    sources: ['menu.cli'],
  },
  {
    id: 'rce.exec',
    category: 'dangerous',
    dangerous: true,
    defaultScopes: ['raw-cli'],
    description: '远程代码执行（预留）',
    sources: ['menu.cli'],
  },
];

// ── Registry ──

const operationMap = new Map<string, OperationMeta>();
for (const op of OPERATIONS) {
  if ((op.id === 'config.read' || op.id === 'config.write') && op.sources && !op.sources.includes('agent-tool')) {
    op.sources = [...op.sources, 'agent-tool'];
  }
  operationMap.set(op.id, op);
}

/**
 * 获取 operation 元数据
 */
export function getOperationMeta(id: string): OperationMeta | null {
  return operationMap.get(id) ?? null;
}

/**
 * 列出所有 operation
 */
export function listOperations(): OperationMeta[] {
  return [...OPERATIONS];
}

/**
 * 列出指定类别的 operation
 */
export function listOperationsByCategory(category: OperationCategory): OperationMeta[] {
  return OPERATIONS.filter(op => op.category === category);
}

/**
 * 列出所有危险 operation
 */
export function listDangerousOperations(): OperationMeta[] {
  return OPERATIONS.filter(op => op.dangerous);
}

/**
 * 检查 operation 是否存在
 */
export function hasOperation(id: string): boolean {
  return operationMap.has(id);
}
