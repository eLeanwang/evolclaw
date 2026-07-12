import fs from 'fs';
import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc.js';
import type { HandoffReturnResponse, HandoffStatusResponse } from '../core/handoff/types.js';
import { HANDOFF_ID_RE } from '../core/handoff/store.js';
import { isHelpFlag } from './help.js';

export interface ParsedReturn {
  handoffId?: string;
  content: string;
}

export function parseReturn(args: string[]): ParsedReturn {
  const dash = args.indexOf('--');
  if (dash >= 0) {
    const beforeDash = args.slice(0, dash);
    const first = beforeDash[0];
    if (first?.startsWith('h-') && !HANDOFF_ID_RE.test(first)) throw new Error(`INVALID_HANDOFF_ID:${first}`);
    const handoffId = first && HANDOFF_ID_RE.test(first) ? first : undefined;
    if (beforeDash.length > (handoffId ? 1 : 0)) throw new Error('HANDOFF_CONTENT_DELIMITER_CONFLICT');
    return { handoffId, content: args.slice(dash + 1).join(' ') };
  }

  const fileIndex = args.indexOf('--text-from-file');
  const filePath = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  if (fileIndex >= 0 && !filePath) throw new Error('HANDOFF_CONTENT_FILE_READ_FAILED');
  const positional = args.filter((_, index) => fileIndex < 0 || (index !== fileIndex && index !== fileIndex + 1));
  const first = positional[0];
  if (first?.startsWith('h-') && !HANDOFF_ID_RE.test(first)) throw new Error(`INVALID_HANDOFF_ID:${first}`);
  const handoffId = first && HANDOFF_ID_RE.test(first) ? first : undefined;
  const contentArgs = handoffId ? positional.slice(1) : positional;
  if (filePath && contentArgs.length > 0) throw new Error('HANDOFF_CONTENT_FILE_CONFLICT');
  if (filePath) {
    try {
      return { handoffId, content: fs.readFileSync(filePath, 'utf8') };
    } catch {
      throw new Error('HANDOFF_CONTENT_FILE_READ_FAILED');
    }
  }
  return { handoffId, content: contentArgs.join(' ') };
}

function printReturn(result: HandoffReturnResponse): void {
  if (result.ok) {
    if (result.code === 'HANDOFF_RETURN_ALREADY_APPLIED') {
      console.log(`✓ handoff ${result.handoff_id} 已接收过相同结果，未重复处理`);
    } else {
      console.log(`✓ handoff ${result.handoff_id} 回流结果已接收`);
    }
    return;
  }
  switch (result.code) {
    case 'HANDOFF_RETURN_CONTENT_REQUIRED':
      console.error(`✗ handoff ${result.handoff_id ?? ''} 必须提供非空回流内容`.trim()); break;
    case 'HANDOFF_NOT_RETURNABLE':
      console.error(`✗ handoff ${result.handoff_id ?? ''} 当前不可 return`.trim()); break;
    case 'HANDOFF_ID_REQUIRED':
      console.error('✗ 当前任务没有可自动选择的 handoff，请指定 ID'); break;
    case 'HANDOFF_TARGET_SESSION_MISMATCH':
      console.error(`✗ handoff ${result.handoff_id ?? ''} 不能从当前会话处理`.trim()); break;
    case 'HANDOFF_RETURN_CONFLICT':
      console.error(`✗ handoff ${result.handoff_id ?? ''} 已接收过不同结果，本次未覆盖`.trim()); break;
    case 'HANDOFF_NOT_FOUND':
      console.error(`✗ handoff 不存在：${result.handoff_id ?? ''}`.trim()); break;
    default:
      console.error(`✗ ${result.error}`);
  }
  process.exitCode = 1;
}

export async function cmdHandoff(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || isHelpFlag(sub)) {
    console.log(`用法: evolclaw handoff <command> [args]

Commands:
  return [handoff-id] <content>       回流当前跨会话结果
  return [handoff-id] --text-from-file <path>
  status <handoff-id>                查询 handoff 状态`);
    return;
  }

  if (sub === 'return') {
    let parsed: ParsedReturn;
    try {
      parsed = parseReturn(args.slice(1));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('INVALID_HANDOFF_ID:')) console.error(`✗ handoff ID 格式无效：${message.slice(message.indexOf(':') + 1)}`);
      else if (message === 'HANDOFF_CONTENT_FILE_READ_FAILED') console.error('✗ 无法读取回流内容文件');
      else console.error('✗ --text-from-file 不能与位置正文同时使用');
      process.exitCode = 1;
      return;
    }
    const result = await ipcQuery<HandoffReturnResponse>(resolvePaths().socket, {
      type: 'handoff-return',
      sessionId: process.env.EVOLCLAW_SESSION_ID,
      handoffId: parsed.handoffId,
      content: parsed.content,
    }, 5000);
    if (!result) {
      console.error('✗ daemon 暂时不可用');
      process.exitCode = 1;
      return;
    }
    printReturn(result);
    return;
  }

  if (sub === 'status') {
    const handoffId = args[1];
    if (!handoffId || !HANDOFF_ID_RE.test(handoffId)) {
      console.error(`✗ handoff ID 格式无效：${handoffId ?? ''}`);
      process.exitCode = 1;
      return;
    }
    const result = await ipcQuery<HandoffStatusResponse | { ok: false; error: string }>(resolvePaths().socket, {
      type: 'handoff-status', sessionId: process.env.EVOLCLAW_SESSION_ID, handoffId,
    }, 5000);
    if (!result) {
      console.error('✗ daemon 暂时不可用');
      process.exitCode = 1;
      return;
    }
    if (result.ok === false) {
      console.error(`✗ ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`handoff ${result.handoff_id}: ${result.state}${result.attention_required ? ` (attention: ${result.attention_reason})` : ''}`);
    return;
  }

  console.error(`未知 handoff 子命令: ${sub}`);
  process.exitCode = 1;
}
