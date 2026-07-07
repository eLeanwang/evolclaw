/**
 * 内置响应模式元数据清单（静态，CLI 与运行时共享）。
 *
 * 为什么独立于模式实现？
 *   - CLI（ec response list/info）是独立进程，无运行时 registry
 *   - 前端 Menu 需要模式清单来渲染选择器
 *   - 元数据（id/显示名/场景/配置 schema）是静态的，与运行时行为（handleInbound 等）解耦
 *
 * Phase 6 实现内置模式时，模式类的元数据字段应与此表保持一致（单一事实源）。
 * 扩展模式（extension）不在此表，由运行时 registry 动态提供。
 */

import type { JSONSchema } from './types.js';

export interface ResponseModeMeta {
  id: string;
  displayName: string;
  description: string;
  applicableScenes: ('private' | 'group')[];
  type: 'builtin';
  configSchema?: JSONSchema;
}

/** 内置响应模式的元数据（见 docs/response-system/builtin-modes.md） */
export const BUILTIN_MODE_META: ResponseModeMeta[] = [
  {
    id: 'interactive',
    displayName: '交互模式',
    description: '输出即回复，所有消息立即处理。人机单聊默认。',
    applicableScenes: ['private'],
    type: 'builtin',
  },
  {
    id: 'proactive',
    displayName: '主动模式',
    description: '工具调用才回复，普通文本作为思考过程。Agent 对话默认。',
    applicableScenes: ['private', 'group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        pre_tool_1stmsgchk: { type: 'boolean', description: '首个工具调用前必须先表态', default: true },
        tool_use_reminder: { type: 'boolean', description: '启用工具使用提醒', default: true },
      },
    },
  },
  {
    id: 'dual-session-lite',
    displayName: '双会话轻量模式',
    description: '辅助会话判断投递时机，主会话批量处理内容。',
    applicableScenes: ['private', 'group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        auxiliaryModel: { type: 'string', description: '辅助会话模型' },
        mainModel: { type: 'string', description: '主会话模型' },
        mentionMode: { type: 'string', enum: ['disabled', 'fast-track'], default: 'fast-track' },
        debounceMs: { type: 'number', description: '辅助队列防抖时间', default: 3000 },
        maxWaitMs: { type: 'number', description: '最早消息最大等待时间', default: 15000 },
        maxQueueSize: { type: 'number', description: '辅助队列强制触发条数', default: 50 },
        maxBatchSize: { type: 'number', description: '主队列批次最大消息数', default: 50 },
        maxBatchBytes: { type: 'number', description: '主队列批次最大字节数', default: 10000 },
      },
    },
  },
  {
    id: 'dual-session',
    displayName: '双会话模式',
    description: '辅助会话判断相关性，主会话处理。繁忙群聊过滤无关消息。',
    applicableScenes: ['group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        auxiliary_model: { type: 'string', description: '辅助会话模型', default: 'haiku' },
        relevance_threshold: { type: 'number', description: '相关性阈值 0-1', default: 0.7 },
      },
    },
  },
  {
    id: 'thread-tracking',
    displayName: '线索追踪模式',
    description: '追踪对话线索，参与的线索全程处理。多话题群聊。',
    applicableScenes: ['group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        max_active_threads: { type: 'number', description: '最多追踪线索数', default: 5 },
        thread_timeout_ms: { type: 'number', description: '线索过期时间（毫秒）', default: 1800000 },
      },
    },
  },
  {
    id: 'workflow',
    displayName: '工作流模式',
    description: '按工作流顺序处理任务，协调分工。任务群。',
    applicableScenes: ['group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        workflow_file: { type: 'string', description: '工作流定义文件路径' },
        coordinator_role: { type: 'string', description: '协调者角色', default: 'owner' },
      },
    },
  },
  {
    id: 'context-enhanced',
    displayName: '上下文增强模式',
    description: '处理前注入群规则文档。工作群遵循规范。',
    applicableScenes: ['group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        document_sources: { type: 'array', description: '文档来源列表' },
        injection_strategy: { type: 'string', enum: ['always', 'on-demand', 'cached'], default: 'cached' },
      },
    },
  },
  {
    id: 'batch-processing',
    displayName: '批量处理模式',
    description: '攒批处理节省资源。低优先级群聊。',
    applicableScenes: ['group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        max_count: { type: 'number', description: '队列达 N 条立即处理', default: 50 },
        max_bytes: { type: 'number', description: '累计字节达 M 立即处理', default: 16384 },
        idle_ms_default: { type: 'number', description: '静默超时（毫秒）', default: 180000 },
        idle_ms_active: { type: 'number', description: '活跃时超时（毫秒）', default: 10000 },
      },
    },
  },
  {
    id: 'selective-response',
    displayName: '选择性响应模式',
    description: '白名单/关键词过滤。只关注特定成员。',
    applicableScenes: ['group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        whitelist_aids: { type: 'array', description: '白名单 AID' },
        blacklist_aids: { type: 'array', description: '黑名单 AID' },
        min_influence_threshold: { type: 'number', description: '最低影响力阈值', default: 0 },
      },
    },
  },
  {
    id: 'rate-limited',
    displayName: '速率限制模式',
    description: '控制响应频率，避免刷屏。',
    applicableScenes: ['private', 'group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        cooldown_ms: { type: 'number', description: '冷却期（毫秒）', default: 0 },
        priority_preemption: { type: 'boolean', description: 'owner/admin 可打断冷却', default: true },
      },
    },
  },
  {
    id: 'autonomous',
    displayName: '自主模式',
    description: '触发器驱动，定时任务。',
    applicableScenes: ['private', 'group'],
    type: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        allow_inbound: { type: 'boolean', description: '是否接受外部消息', default: false },
        trigger_only: { type: 'boolean', description: '仅触发器驱动', default: true },
      },
    },
  },
];

/** 按 id 查找内置模式元数据 */
export function findBuiltinMeta(id: string): ResponseModeMeta | undefined {
  return BUILTIN_MODE_META.find(m => m.id === id);
}
