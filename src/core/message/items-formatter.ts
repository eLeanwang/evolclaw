import type { ThoughtItem } from '../../types.js';

/**
 * 把结构化 ThoughtItem 数组降级为人类可读的纯文本。
 * 用于不支持 thought 能力的渠道（Feishu/WeChat/DingTalk/QQBot/WeCom），
 * 在 send() 中收到 activity.batch 后调用。
 */
export function formatItemsAsText(items: ThoughtItem[]): string {
  if (!items || items.length === 0) return ''; // early exit
  const lines: string[] = [];
  for (const item of items) {
    const line = formatItem(item);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function formatItem(item: ThoughtItem): string {
  switch (item.kind) {
    case 'text':
      return item.text;
    case 'reasoning':
      return `💭 ${item.text}`;
    case 'tool_call': {
      const desc = item.text || summarizeArgs(item.arguments);
      if (!desc) return `🔧 ${item.name}`;
      // 多行 desc（如 Edit diff）：第一行跟工具名同行，代码块从新行开始
      if (desc.includes('\n')) {
        const nlIdx = desc.indexOf('\n');
        return `🔧 ${item.name}  ${desc.slice(0, nlIdx)}\n${desc.slice(nlIdx + 1)}`;
      }
      return `🔧 ${item.name}: ${desc}`;
    }
    case 'tool_result': {
      if (!item.ok) {
        const errMsg = item.error || (typeof item.result === 'string' ? item.result : '执行失败');
        return `⚠️ ${item.name}: ${errMsg}`;
      }
      return item.text ? `✓ ${item.name}: ${item.text}` : `✓ ${item.name}`;
    }
    case 'progress':
      return `⏳ ${item.text}`;
    case 'notice':
      return item.severity === 'warn' ? `⚠️ ${item.text}` : item.text;
    case 'summary':
      return item.is_error ? `❌ ${item.text}` : item.text;
    default:
      return '';
  }
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as any;
  if (typeof a.description === 'string') return a.description;
  if (typeof a.file_path === 'string') return a.file_path;
  if (typeof a.pattern === 'string') return a.pattern;
  if (typeof a.command === 'string') return a.command.substring(0, 80);
  if (typeof a.prompt === 'string') return a.prompt.substring(0, 80);
  if (typeof a.query === 'string') return a.query.substring(0, 80);
  return '';
}
