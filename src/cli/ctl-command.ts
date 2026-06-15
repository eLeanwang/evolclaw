import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc.js';
import { isHelpFlag } from './help.js';

// ==================== Ctl ====================

export async function cmdCtl(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error(`用法: evolclaw ctl <command> [args...]

查询:
  status                    查看会话状态
  check                     检查渠道健康状态
  pwd                       显示当前项目路径
  help                      显示帮助

配置:
  model [model-id]          查看/切换模型（如 opus, sonnet, haiku）
  effort [low|medium|high]  查看/切换推理强度
  compact                   压缩当前会话上下文
  perm [mode]               查看/切换权限模式

消息:
  send <消息内容>           主动发送文本消息（proactive 模式）
  file [channel] <path>     发送项目内文件
  queue                     查看/管理会话消息队列

Agent:
  agent <subcommand>        EvolAgent 管理（list/show/new/enable/disable/reload/delete）

触发器:
  trigger                   查看活跃触发器
  trigger list              查看所有触发器（含历史）
  trigger set --delay <时长> --prompt <内容>          延迟触发（如 15m、2h）
  trigger set --at <ISO时间> --prompt <内容>          定时触发（如 2026-06-10T09:00）
  trigger set --cron '<表达式>' --prompt <内容>       周期触发（如 '*/15 * * * *'）
  trigger cancel <名称>     取消触发器
  trigger update <名称> ... 修改触发器参数

运维:
  restart [channel]         重启服务或重连指定渠道

示例:
  evolclaw ctl model sonnet
  evolclaw ctl effort high
  evolclaw ctl compact
  evolclaw ctl "trigger set --cron '*/15 * * * *' --prompt '现在时间？'"`);
    process.exit(1);
  }

  // help 不需要连接服务，直接复用无参数时的帮助输出
  if (isHelpFlag(args[0])) {
    return cmdCtl([]);
  }

  const sessionId = process.env.EVOLCLAW_SESSION_ID;
  if (!sessionId) {
    console.error('错误: EVOLCLAW_SESSION_ID 未设置（仅在 evolclaw 托管环境中可用）');
    process.exit(1);
  }

  const cmd = '/' + args.join(' ');
  const socketPath = resolvePaths().socket;

  // compact/restart 等长时操作使用更长超时
  const longRunning = ['/compact', '/restart'];
  const timeout = longRunning.some(c => cmd.startsWith(c)) ? 60_000 : 10_000;

  const result = await ipcQuery(socketPath, {
    type: 'ctl',
    cmd,
    sessionId,
  }, timeout);

  if (!result) {
    console.error('错误: 无法连接 evolclaw 服务');
    process.exit(1);
  }

  const ctlResult = result as any;
  if (ctlResult.ok) {
    console.log(ctlResult.result);
  } else {
    console.error(ctlResult.error || '执行失败');
    process.exit(1);
  }
}

