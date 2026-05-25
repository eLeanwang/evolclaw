import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { logger } from './logger.js';
import type { ErrorRule } from '../types.js';

export enum ErrorType {
  SDK_TIMEOUT = 'sdk_timeout',
  API_ERROR = 'api_error',
  AUTH_ERROR = 'auth_error',
  FILE_CORRUPT = 'file_corrupt',
  STREAM_ERROR = 'stream_error',
  CONTEXT_TOO_LONG = 'context_too_long',
  UNKNOWN = 'unknown'
}

/**
 * 错误来源前缀 — 区分基础设施异常 vs Agent 任务失败
 *
 * infra:  基础设施级（SDK 崩溃、API 不可用、文件损坏）— 应累计安全模式
 * agent:  Agent 任务级（权限拒绝、max turns、工具失败）— 仅统计，不累计安全模式
 */
export const ERROR_PREFIX = {
  INFRA: 'infra',
  AGENT: 'agent',
} as const;

/**
 * 判断 Agent complete.subtype 是否属于系统级故障（应累计安全模式）
 *
 * 非系统级（用户操作或任务边界）：
 * - end_turn / max_turns: Agent 正常结束或达到轮次上限
 * - permission_denied: 用户主动拒绝权限
 * - stop: 用户主动停止
 *
 * 系统级（SDK/模型/平台故障）：
 * - error_model / error_tool_use / error_api 等：基础设施异常
 * - 未知 subtype：保守地视为系统级
 *
 * terminalReason 提供更精确的判断（SDK 0.2.100+）：
 * - rapid_refill_breaker: API 限流，不是代码问题
 * - tool_deferred: 工具延迟，不是错误
 * - stop_hook_prevented: Stop hook 阻止，不是错误
 * - aborted_streaming / aborted_tools: 中断，已有中断处理逻辑
 */
const NON_INFRA_SUBTYPES = new Set([
  'end_turn',
  'max_turns',
  'permission_denied',
  'stop',
]);

const NON_INFRA_TERMINAL_REASONS = new Set([
  'rapid_refill_breaker',
  'tool_deferred',
  'stop_hook_prevented',
  'aborted_streaming',
  'aborted_tools',
]);

export function isInfraError(subtype?: string, terminalReason?: string): boolean {
  // terminalReason 优先级更高（更精确）
  if (terminalReason && NON_INFRA_TERMINAL_REASONS.has(terminalReason)) {
    return false;
  }

  if (!subtype) return true;  // 未知 subtype，保守视为系统级
  return !NON_INFRA_SUBTYPES.has(subtype);
}

/** 为 errorType 添加来源前缀 */
export function prefixErrorType(prefix: string, errorType: string): string {
  return `${prefix}:${errorType}`;
}

// ── 错误字典 ──────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set(['retry', 'stop', 'ignore']);

let _dictPath: string | null = null;
let _rules: ErrorRule[] = [];
let _lastMtime = 0;

function getDictPath(): string {
  if (!_dictPath) {
    const userDict = path.join(resolvePaths().dataDir, 'error-dict.json');
    if (fs.existsSync(userDict)) {
      _dictPath = userDict;
    } else {
      // Bundled default: src/utils/ → src/data/ (dev) or dist/utils/ → dist/data/ (prod)
      _dictPath = path.resolve(import.meta.dirname, '..', 'data', 'error-dict.json');
    }
  }
  return _dictPath;
}

/** 校验单条规则，返回错误原因（null = 合法） */
function validateRule(r: any, index: number): string | null {
  if (!r || typeof r !== 'object') return `rules[${index}]: 不是对象`;
  if (!r.id || typeof r.id !== 'string') return `rules[${index}]: 缺少 id 或类型不是 string`;
  if (!r.match || typeof r.match !== 'string') return `rules[${index}] (${r.id}): 缺少 match 或类型不是 string`;
  if (!VALID_ACTIONS.has(r.action)) return `rules[${index}] (${r.id}): action 无效 "${r.action}"，允许值: retry/stop/ignore`;
  if (r.type !== undefined && typeof r.type !== 'string') return `rules[${index}] (${r.id}): type 类型不是 string`;
  if (r.message !== undefined && typeof r.message !== 'string') return `rules[${index}] (${r.id}): message 类型不是 string`;
  return null;
}

/**
 * 刷新字典：检查文件 mtime，有变化则重新读取并校验。
 * 校验不通过 → 不更新内存数据，记录告警日志。
 */
function refreshDict(): void {
  const dictPath = getDictPath();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dictPath);
  } catch {
    // 文件不存在 → 清空规则（首次）或保持不变（之前有数据且文件被删）
    if (_rules.length > 0) {
      logger.warn('[error-dict] 字典文件已删除，清空规则: %s', dictPath);
      _rules = [];
      _lastMtime = 0;
    }
    return;
  }

  const mtime = stat.mtimeMs;
  if (mtime === _lastMtime) return;  // 文件未变化，跳过

  // 文件有变化，尝试加载
  try {
    const content = fs.readFileSync(dictPath, 'utf-8');
    let raw: any;
    try {
      raw = JSON.parse(content);
    } catch (parseErr: any) {
      logger.warn('[error-dict] JSON 解析失败，保留原有规则: %s — %s', dictPath, parseErr.message);
      _lastMtime = mtime;  // 标记已检查，避免重复读取
      return;
    }

    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) {
      logger.warn('[error-dict] 字典格式错误（缺少 rules 数组），保留原有规则: %s', dictPath);
      _lastMtime = mtime;
      return;
    }

    // 逐条校验
    const errors: string[] = [];
    for (let i = 0; i < raw.rules.length; i++) {
      const err = validateRule(raw.rules[i], i);
      if (err) errors.push(err);
    }

    if (errors.length > 0) {
      logger.warn('[error-dict] 字典校验失败（%d 条错误），保留原有规则:\n  %s', errors.length, errors.join('\n  '));
      _lastMtime = mtime;
      return;
    }

    // 全部通过，更新
    _rules = raw.rules;
    _lastMtime = mtime;
    logger.info('[error-dict] 已加载 %d 条规则: %s', _rules.length, dictPath);
  } catch (err: any) {
    logger.warn('[error-dict] 读取失败，保留原有规则: %s — %s', dictPath, err.message);
  }
}

/**
 * 匹配错误消息，返回首条命中的规则。
 * 每次调用自动检查文件变化（基于 mtime，无变化零开销）。
 * @param errorMessage 已 toLowerCase 的错误消息
 */
export function matchErrorRule(errorMessage: string): ErrorRule | null {
  refreshDict();
  for (const rule of _rules) {
    if (errorMessage.includes(rule.match.toLowerCase())) {
      return rule;
    }
  }
  return null;
}

/** 获取当前已加载的规则数量（供测试和状态查询使用） */
export function getLoadedRuleCount(): number {
  refreshDict();
  return _rules.length;
}

/** 重置字典状态（仅供测试使用） */
export function _resetDict(): void {
  _rules = [];
  _lastMtime = 0;
  _dictPath = null;
}

/** 设置字典文件路径（仅供测试使用） */
export function _setDictPath(p: string): void {
  _dictPath = p;
  _lastMtime = 0;  // 强制下次刷新
}

// ── 错误分类 / 重试 / 消息 ──────────────────────────────────────────

export function classifyError(error: any): ErrorType {
  const msg = (error?.message || '').toLowerCase();

  // 字典优先 — 命中则直接返回
  const rule = matchErrorRule(msg);
  if (rule) {
    if (rule.type) return rule.type as ErrorType;
    if (rule.action === 'retry') return ErrorType.API_ERROR;
    if (rule.action === 'stop') return ErrorType.AUTH_ERROR;
    return ErrorType.UNKNOWN;
  }

  // 内置兜底规则（结构性、稳定的错误模式）
  if (msg.includes('context_length_exceeded') || msg.includes('context_compact_failed')
    || msg.includes('context limit') || msg.includes('input is too long')
    || msg.includes('上下文过长')) {
    return ErrorType.CONTEXT_TOO_LONG;
  }

  if (msg.includes('401') || msg.includes('authentication_error')) {
    return ErrorType.AUTH_ERROR;
  }

  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return ErrorType.SDK_TIMEOUT;
  }

  if (msg.includes('enoent') || msg.includes('corrupt')) {
    return ErrorType.FILE_CORRUPT;
  }

  if (msg.includes('aborted') || msg.includes('interrupted')) {
    return ErrorType.STREAM_ERROR;
  }

  return ErrorType.UNKNOWN;
}

/**
 * 判断错误是否可重试（暂时性 API 错误）
 * 403 算力池切换、429 限流、5xx 服务端错误
 * 注意：401 认证错误不可重试（API Key 无效不会因重试恢复）
 */
export function isRetryableError(error: any): boolean {
  const msg = error?.message || String(error);
  const lower = msg.toLowerCase();

  // 字典优先 — 命中则直接返回
  const rule = matchErrorRule(lower);
  if (rule) return rule.action === 'retry';

  // 内置兜底规则（结构性错误码）
  if (lower.includes('401') || lower.includes('authentication_error')) {
    return false;  // 认证错误不可重试
  }

  // HTTP 5xx / 429 — 标准可重试状态码
  if (/api error: (429|5\d{2})\b/.test(lower)) return true;

  return false;
}

export function getErrorMessage(error: any, terminalReason?: string, includeEmoji = true): string {
  // terminalReason 提供更精确的错误提示（SDK 0.2.100+）
  if (terminalReason) {
    const prefix = includeEmoji ? '❌ ' : '';
    const warnPrefix = includeEmoji ? '⚠️ ' : '';
    switch (terminalReason) {
      case 'max_turns':
        return `${prefix}任务达到最大轮次限制，请简化需求或分步执行`;
      case 'prompt_too_long':
        return `${warnPrefix}输入过长，请精简提问或使用 /compact 压缩上下文`;
      case 'rapid_refill_breaker':
        return `${warnPrefix}API 限流中，请稍后重试`;
      case 'context_compact_failed':
        return `${warnPrefix}上下文过长，自动压缩失败，请手动输入 /compact 重试`;
      case 'model_error':
        return `${prefix}模型服务异常，请稍后重试`;
      case 'tool_error':
        return `${prefix}工具执行失败，请检查操作或重试`;
      case 'permission_denied':
        return `${prefix}权限被拒绝，操作已取消`;
      case 'aborted_streaming':
      case 'aborted_tools':
        return `${prefix}任务已中断`;
    }
  }

  // 回退到原有的错误消息匹配逻辑
  const msg = error?.message || String(error);

  // 字典优先 — 命中且有自定义消息则直接返回
  const rule = matchErrorRule(msg.toLowerCase());
  if (rule?.message) return rule.message;

  // 内置兜底规则（结构性错误）
  const warnPrefix = includeEmoji ? '⚠️ ' : '';
  const errPrefix = includeEmoji ? '❌ ' : '';
  if (msg.includes('CONTEXT_COMPACT_FAILED') || msg.includes('context_length_exceeded')
    || msg.includes('Context limit')) {
    return `${warnPrefix}上下文过长，自动压缩失败，请手动输入 /compact 重试`;
  }
  if (msg.includes('401') || msg.includes('authentication_error')) {
    return `${errPrefix}API Key 无效，请检查密钥配置。使用 /status 查看当前配置`;
  }
  if (msg.includes('timeout')) {
    return `${warnPrefix}请求超时，请重试`;
  }

  return `${errPrefix}处理消息时出错，请稍后重试`;
}
