#!/usr/bin/env node
// Suppress AUN SDK logs BEFORE any imports (SDK may initialize during module load)
process.env.AUN_LOG_INI_DISABLE = '1';

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

云部署非交互式初始化（结构化 JSON 输出）:
  evolclaw init --non-interactive --owner <aid> [--format json] [选项]
    --owner <aid>                        必填。唯一 daemon owner AID
    --baseagent <claude|codex|gemini>    可选。默认从 PATH 检测
    --projectpath <abs-path>             可选。默认项目目录（必须绝对路径，自动创建）
    --ecweb                              可选。启用 ECWeb 自启动
    --format json                        可选但推荐。stdout 输出 init.result JSON
    --force                              已有不同 owner 时强制覆盖

配置渠道（先 evolclaw agent new 创建 agent）:
  evolclaw init aun           AUN owner 绑定（daemon 或指定 agent）
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
          owner: getArgValue(args, '--owner'),
          projectpath: getArgValue(args, '--projectpath'),
          ecweb: args.includes('--ecweb'),
          format: getArgValue(args, '--format'),
        });
      }
      break;
    case 'start':
      await cmdStart({
        diagnose: args.includes('--diagnose') || args.includes('-d'),
        foreground: args.includes('--foreground'),
      });
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
      {
        const { cmdTrigger } = await import('./trigger-command.js');
        await cmdTrigger(args.slice(1));
      }
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
    case 'fs': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      const { cmdFs } = await import('./fs-command.js');
      await cmdFs(args.slice(1));
      break;
    }
    case 'msg': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdMsg(args.slice(1));
      break;
    }
    case 'handoff': {
      const { cmdHandoff } = await import('./handoff-command.js');
      await cmdHandoff(args.slice(1));
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
    case 'response': {
      const { cmdResponse } = await import('./response.js');
      await cmdResponse(args.slice(1));
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
      console.log(`Usage: evolclaw {init|start|stop|restart|status|logs|watch|ctl|queue|trigger|handoff|diagnose|net|mv}

Commands:
  init          初始化 evolclaw home (${resolvePaths().defaultsConfig})
  init feishu   飞书扫码登录并写入配置
  init wechat   微信扫码登录并写入配置
  init dingtalk 钉钉扫码登录并写入配置
  init qqbot    QQ 机器人扫码绑定并写入配置
  init wecom    企业微信 AI Bot 配置（手动输入 Bot ID + Secret）
  start         启动服务 (默认)
                  --foreground  前台运行，适合 systemd/Docker 直接管理进程
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
  trigger       daemon 级触发器管理（list/show/history/create/update/run）
  handoff       跨会话任务回流
                  handoff return [id] <content>  将当前子会话结果交回来源会话处理
                  handoff list/trace             查询实例和审计事件
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
  response      响应模式管理（查看/切换/配置，作用域：全局/agent/关系）
                  response list      列出所有响应模式
                  response current   显示当前作用域生效的默认模式
                  response info <id> 查看单个模式详情（场景/配置参数）
                  response set <id>  设置默认模式（--scene private/group）
                  response config    查看/修改模式配置参数
                  response reset     清除指定作用域设置
                  response help      查看完整用法
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
  fs            AUN 文件系统统一入口
                  fs ls|stat|cat|find <AID>:/path
                  fs cp <src> <dst>      上传/下载/远程复制
                  fs mv <src> <dst>      移动/改名（同后端）
                  fs rm [-r] <AID>:/path
                  fs mkdir [-p] <AID>:/path
                  fs ln -s <target> <AID>:/path
                  fs chmod +r|o-r <AID>:/path
                  fs setfacl|getfacl <AID>:/path
                  fs token issue|revoke|ls <AID>:/path
                  fs df <AID>:
                  fs mount <target> --volume <id>|--source <src>
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
