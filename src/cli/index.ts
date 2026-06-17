import fs from 'fs';
import path from 'path';
import { resolvePaths, getPackageRoot } from '../paths.js';
import { cmdInit } from './init.js';
import { cmdInitWechat, cmdInitFeishu, cmdInitDingtalk, cmdInitQQBot, cmdInitWecom, cmdInitAun } from './init-channel.js';
import { isHelpFlag, getArgValue } from './help.js';
import * as platform from '../utils/cross-platform.js';
import { cmdRestartMonitor } from './restart-monitor.js';
import { cmdAid, cmdRpc, cmdStorage, cmdMsg, cmdGroup } from './aun-commands.js';
import { cmdAgent } from './agent-command.js';
import { cmdCtl } from './ctl-command.js';
import { cmdQueue } from './queue-command.js';
import { cmdTrigger } from './trigger-command.js';
import { cmdStart, cmdStop, cmdRestart, cmdStatus, cmdLogs, cmdWatchCommand, cmdDev, cmdMv, cmdDiagnose } from './daemon-commands.js';

// Suppress Node.js ExperimentalWarning (e.g. SQLite) from cluttering CLI output
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name === 'ExperimentalWarning') return; process.stderr.write((w.stack ?? String(w)) + '\n'); });

export async function main(args: string[]) {
  const cmd = args[0] || 'start';

  if (cmd === '--version' || cmd === '-v' || cmd === '-V') {
    const pkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'));
    console.log(pkg.version);
    return;
  }

  switch (cmd) {
    case 'init':
      if (isHelpFlag(args[1])) {
        console.log(`用法: evolclaw init [渠道] [选项]

仅初始化 defaults.json:
  evolclaw init                          交互式（写完 defaults.json 后嵌套 agent new）
  evolclaw init --non-interactive [选项]
    --baseagent <claude|codex|gemini>    默认: PATH 中第一个可用项
    --force                              已存在 defaults.json 时覆盖

配置渠道（先 evolclaw agent new 创建 agent）:
  evolclaw init aun           AUN 渠道配置（AID 创建/绑定）
  evolclaw init feishu        飞书扫码登录
  evolclaw init wechat        微信扫码登录
  evolclaw init dingtalk      钉钉扫码登录
  evolclaw init qqbot         QQ 机器人扫码绑定
  evolclaw init wecom         企业微信 AI Bot 配置（手动输入）`);
      } else if (args[1] === 'aun') {
        const { suppressSdkLogs } = await import('../aun/aid/index.js');
        suppressSdkLogs();
        await cmdInitAun();
      } else if (args[1] === 'wechat') {
        const { suppressSdkLogs } = await import('../aun/aid/index.js');
        suppressSdkLogs();
        await cmdInitWechat();
      } else if (args[1] === 'feishu') {
        const { suppressSdkLogs } = await import('../aun/aid/index.js');
        suppressSdkLogs();
        await cmdInitFeishu();
      } else if (args[1] === 'dingtalk') {
        const { suppressSdkLogs } = await import('../aun/aid/index.js');
        suppressSdkLogs();
        await cmdInitDingtalk();
      } else if (args[1] === 'qqbot') {
        const { suppressSdkLogs } = await import('../aun/aid/index.js');
        suppressSdkLogs();
        await cmdInitQQBot();
      } else if (args[1] === 'wecom') {
        await cmdInitWecom();
      } else if (args[1] && !args[1].startsWith('-')) {
        const supported = ['feishu', 'wechat', 'aun', 'dingtalk', 'qqbot', 'wecom'];
        console.error(`❌ 不支持的渠道: ${args[1]}`);
        console.error(`   支持的渠道: ${supported.join(', ')}`);
        process.exit(1);
      } else {
        const { suppressSdkLogs } = await import('../aun/aid/index.js');
        suppressSdkLogs();
        const nonInteractive = args.includes('--non-interactive');
        await cmdInit({
          nonInteractive,
          baseagent: getArgValue(args, '--baseagent'),
          force: args.includes('--force'),
        });
      }
      break;
    case 'start':
      await cmdStart({ diagnose: args.includes('--diagnose') || args.includes('-d') });
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdRestart({ clear: args.includes('--clear'), diagnose: args.includes('--diagnose') || args.includes('-d') });
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'logs':
      cmdLogs(args.slice(1));
      break;
    case 'watch':
      await cmdWatchCommand(args.slice(1));
      break;
    case 'restart-monitor':
      await cmdRestartMonitor();
      break;
    case 'dev':
      await cmdDev(args.slice(1));
      break;
    case 'mv':
      await cmdMv(args[1], args[2]);
      break;
    case 'diagnose':
      await cmdDiagnose();
      break;
    case 'net': {
      const { cmdNet } = await import('./net-check.js');
      await cmdNet(args.slice(1));
      break;
    }
    case 'ctl':
      await cmdCtl(args.slice(1));
      break;
    case 'queue':
      await cmdQueue(args.slice(1));
      break;
    case 'trigger':
      await cmdTrigger(args.slice(1));
      break;
    case 'agent': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdAgent(args.slice(1));
      break;
    }
    case 'aid': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdAid(args.slice(1));
      break;
    }
    case 'rpc': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdRpc(args.slice(1));
      break;
    }
    case 'storage': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdStorage(args.slice(1));
      break;
    }
    case 'msg': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdMsg(args.slice(1));
      break;
    }
    case 'group': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdGroup(args.slice(1));
      break;
    }
    case 'model': {
      const { cmdModel } = await import('./model.js');
      await cmdModel(args.slice(1));
      break;
    }
    case 'config': {
      const { cmdConfig } = await import('./config.js');
      await cmdConfig(args.slice(1));
      break;
    }
    case 'stats': {
      const { handleStats } = await import('./stats.js');
      await handleStats(args.slice(1));
      break;
    }
    case 'version':
    case '-v':
    case '--version': {
      const { handleVersion } = await import('./version.js');
      handleVersion(args.slice(1));
      break;
    }
    case 'bench': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      const { cmdBench } = await import('./bench.js');
      await cmdBench(args.slice(1));
      break;
    }
    case 'link-rules': {
      const { cmdLinkRules } = await import('./link-rules.js');
      cmdLinkRules(args.slice(1));
      break;
    }
    default:
      console.log(`Usage: evolclaw {init|start|stop|restart|status|logs|watch|ctl|queue|trigger|diagnose|net|mv}

Commands:
  init          初始化 evolclaw home (${resolvePaths().defaultsConfig})
  init feishu   飞书扫码登录并写入配置
  init wechat   微信扫码登录并写入配置
  init dingtalk 钉钉扫码登录并写入配置
  init qqbot    QQ 机器人扫码绑定并写入配置
  init wecom    企业微信 AI Bot 配置（手动输入 Bot ID + Secret）
  start         启动服务 (默认)
  stop          停止服务
  restart       重启服务
                  --clear  顺带 SIGKILL 跨 HOME 残留的 evolclaw 主进程
  status        查看状态
  logs          查看日志 (tail -f, 着色渲染)
                  --level error|warn   只显示指定级别及以上
                  --module <name>      只显示指定模块（如 feishu、AgentRunner）
                  --raw                原始输出，不着色
  watch         监控面板选择菜单（↑↓ 选择 log/aid/msg）
  watch logs    勾选日志类型后实时监控（记忆上次选择，存入 evolclaw.json）
  watch log <类型...>  直接监控指定类型（如 evolclaw aun），不读写偏好
  watch aid     AID 连接状态实时监控（显示各 AID 在线/离线/重连状态）
  watch msg     消息监控（三面板交互式 TUI：AID 列表 / 对端统计 / 消息流）
  ctl           运行时自管理（模型切换、推理强度、压缩上下文等）
                  evolclaw ctl help 查看完整命令列表
  trigger       daemon 级触发器管理（list/show/create/update/run）
  queue          消息队列查询与操作
                  queue --agent <aid>          查看 agent 的所有队列
                  queue --agent <aid> --clear  清空待处理消息
                  queue --agent <aid> --interrupt --sessionkey <key>  打断处理中任务
  agent         管理 EvolAgent
                  agent              列出所有 agent
                  agent <name>       查看指定 agent 详情
                  agent new <name>   创建新 agent（交互式）
                  agent new <name> --non-interactive ...  非交互创建（自动化）
                    必填: --project <absolute path>
                    可选: --baseagent <claude|codex|gemini>  (默认: PATH 中第一个可用)
                          --owner <aid>
                          --name <display-name>
                          --description <text>
                          --force                            (覆盖已有 config.json)
                  agent reload       全量 resync（扫磁盘，新增上线、删除下线、修改热更新）
                  agent reload <n>   热重载指定 agent 配置
  model         模型管理（查看/切换，作用域：全局/agent/关系/会话）
                  model list         列出可用模型，标注各作用域命中
                  model current      显示实际生效的模型 + 来源
                  model info <id>    查看单个模型详情（价格/上下文/模态等）
                  model use <id>     切换模型（--self/--peer/--session 决定作用域）
                  model effort <lv>  设置推理强度
                  model reset        清除指定作用域设置，回落上一级
                  model help         查看完整用法
  aid           AID 身份管理
                  aid list           列出本地所有 AID
                  aid show <aid>     查看本地 AID 详情（证书有效期、私钥状态）
                  aid new <aid>      创建新 AID 身份
                  aid lookup <aid>   远程探测 AID（是否存在 + 网关 + agent.md）
                  aid agentmd put <aid>  签名并上传 agent.md
                  aid agentmd get <aid>  下载并验签 agent.md
                  aid delete <aid>             删除指定 AID
                  aid delete --orphan          清理无私钥的外部 AID 缓存
                  aid delete --unrecoverable   清理云端公钥已变更、不可恢复的 AID
                                                 默认 dry-run，加 --yes 执行
  net           网络链路诊断
                  net check [<aid>]  10 步链路检测（DNS→Discovery→TCP→TLS→WSS→Auth→Ping→Echo）
                  net help           查看详细帮助
  rpc           AUN RPC 调用
                  rpc --as <aid> --params <json|jsonl|file>
  storage       文件存储
                  storage upload <aid> <file> <path> [--public]
                  storage download <aid> <url> [local-path]
                  storage ls <aid> [prefix]
                  storage rm <aid> <path>
                  storage quota <aid>
  diagnose      诊断启动环境（配置、数据库、进程）
  mv <old> <new>  迁移项目目录（保留 Claude/Codex/EvolClaw 会话）
  bench         AUN 消息性能基准测试
                  bench --aids 5 --rounds 10 --concurrency 5

Environment:
  EVOLCLAW_HOME   数据目录 (默认: ~/.evolclaw)
  LOG_LEVEL       日志级别 (默认: INFO)
  MESSAGE_LOG     消息日志 (默认: true)
  EVENT_LOG       事件日志 (默认: true)`);
      process.exit(1);
  }
}

// 直接运行时自动执行（node dist/cli/index.js ...）
if (platform.isMainScript(import.meta.url)) {
  main(process.argv.slice(2));
}
