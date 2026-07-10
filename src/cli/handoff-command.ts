import fs from 'fs';
import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc.js';
import type { HandoffReturnIpcResponse } from '../core/message/handoff.js';
import { getArgValue, isHelpFlag } from './help.js';

function collectReturnContent(args: string[]): string {
  const fromFile = getArgValue(args, '--text-from-file');
  if (fromFile) {
    return fs.readFileSync(fromFile, 'utf-8');
  }
  const dash = args.indexOf('--');
  const source = dash >= 0 ? args.slice(dash + 1) : args.filter(arg => !arg.startsWith('--'));
  return source.join(' ');
}

export async function cmdHandoff(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || isHelpFlag(sub)) {
    console.log(`用法: evolclaw handoff <command> [args]

Commands:
  return <content>                    将当前子会话结果回流给来源会话
  return --text-from-file <path>      从文件读取回流内容

示例:
  ec handoff return "target 回复内容"
  ec handoff return --text-from-file result.txt`);
    return;
  }

  if (sub !== 'return') {
    console.error(`未知 handoff 子命令: ${sub}`);
    process.exit(1);
  }

  const content = collectReturnContent(args.slice(1));
  if (!content.trim()) {
    console.error('❌ 缺少回流内容');
    process.exit(1);
  }

  const result = await ipcQuery<HandoffReturnIpcResponse>(
    resolvePaths().socket,
    {
      type: 'handoff-return',
      sessionId: process.env.EVOLCLAW_SESSION_ID,
      content,
    },
    5000,
  );
  if (!result?.ok) {
    console.error(`❌ 回流失败: ${result?.error || 'daemon unavailable'}`);
    process.exit(1);
  }
  console.log(`✓ 已回流 ${result.result_message_id ?? ''}`);
}
