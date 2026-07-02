import type { OperationMeta, CommandScope, OperationCategory, CommandSource } from '../../types.js';

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
    sources: ['menu.cli'],
  },
  {
    id: 'model.check',
    category: 'diagnose',
    dangerous: false,
    defaultScopes: ['agent'],
    description: '检查模型可用性（可能触发网关探测）',
    sources: ['menu.cli'],
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
    sources: ['menu.cli'],
  },

  // ── Session Operations ──
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

  // ── Agent Operations ──
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
    id: 'config.read',
    category: 'read',
    dangerous: true,
    defaultScopes: ['process'],
    description: '查询配置',
    sources: ['menu', 'control'],
  },
  {
    id: 'config.write',
    category: 'process',
    dangerous: true,
    defaultScopes: ['process'],
    description: '修改配置',
    sources: ['menu', 'control'],
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
