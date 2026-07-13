import fs from 'fs';
import path from 'path';
import { agentMdPath, resolveRoot } from '../paths.js';
import { getArgValue, isHelpFlag, wantsHelp } from './help.js';

// ==================== AID ====================

function resolveAunPath(args: string[]): string | undefined {
  const idx = args.indexOf('--aun-path');
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return process.env.AUN_HOME || undefined;
}

export async function cmdAid(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = getArgValue(args, '--format') === 'json';
  const aunPath = resolveAunPath(args);

  if (!sub || isHelpFlag(sub)) {
    console.log(`用法: evolclaw aid <command>

Commands:
  list              列出本地所有 AID（实测 sign+verify）
  show <aid>        查看本地 AID 详情（证书、私钥、签名能力）
  new <aid>         创建新 AID 身份
  delete <aid>      删除指定本地 AID（无网络注销）
  delete --orphan         批量清理无私钥的外部 AID 缓存
  delete --no-cert        批量清理无私钥也无公钥证书的孤儿目录
  delete --unrecoverable  批量清理云端公钥已变更、本地不可恢复的 AID
                          批量删除默认 dry-run，加 --yes 执行
  lookup <aid>      远程探测 AID（是否存在 + 网关 + agent.md）
  agentmd put <aid> 读本地 agent.md → 签名 → 上传
  agentmd get <aid> 下载 agent.md → 验签 → 本地持久化

Options:
  --format json     输出 JSON 格式
  --help, -h        各子命令均支持，查看详细用法

示例:
  evolclaw aid list
  evolclaw aid show toleiliang2.agentid.pub
  evolclaw aid new reviewer.agentid.pub
  evolclaw aid delete --help
  evolclaw aid delete old.agentid.pub
  evolclaw aid delete --orphan
  evolclaw aid delete --unrecoverable --yes
  evolclaw aid lookup someone.agentid.pub
  evolclaw aid agentmd put mybot.agentid.pub
  evolclaw aid agentmd get someone.agentid.pub`);
    return;
  }

  const { aidList, aidListVerified, aidCreate, aidShow, aidDelete, aidLookup, agentmdPut, agentmdGet, buildInitialAgentMd, isValidAid } = await import('../aun/aid/index.js');

  if (sub === 'list') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw aid list [筛选选项] [--no-verify] [--format json]

列出本地 AID 并跑 sign+verify 自检。

筛选选项（可组合，不指定 = 列出 mine + broken + peer-cert）:
  --mine            仅本地可用身份（实测可签名+验签通过）
  --broken          仅有私钥但不可用（公钥不匹配 / 证书过期 / sign 失败）
  --peer-cert       仅对端 AID（无私钥，有公钥证书）
  --no-cert         仅无私钥无证书的目录（默认隐藏，需用 aid delete --no-cert 清理）

选项:
  --no-verify       跳过 sign+verify 实测，仅静态扫描（更快，mine/broken 仅按静态判定近似）
  --format json     JSON 格式输出

输出图标:
  🔑   有私钥
  ✅   实测可签名/验签
  ❌   不可签名（公钥不匹配 / sign 失败 / verify 失败等）
  ⌛   证书过期
  📜   有公钥证书
  📄   有 agent.md

示例:
  evolclaw aid list                  列出 mine + broken + peer-cert
  evolclaw aid list --mine           仅可用身份
  evolclaw aid list --mine --broken  所有有私钥的 AID
  evolclaw aid list --no-cert        仅无私钥无证书的孤儿目录
  evolclaw aid list --no-verify      跳过实测，快速静态扫描`);
      return;
    }

    const wantMine = args.includes('--mine');
    const wantBroken = args.includes('--broken');
    const wantPeerCert = args.includes('--peer-cert');
    const wantNoCert = args.includes('--no-cert');
    const noVerify = args.includes('--no-verify');

    const anyFilter = wantMine || wantBroken || wantPeerCert || wantNoCert;
    // 默认: mine + broken + peer-cert（隐藏 no-cert，需显式 --no-cert 才列）
    const showMine = anyFilter ? wantMine : true;
    const showBroken = anyFilter ? wantBroken : true;
    const showPeerCert = anyFilter ? wantPeerCert : true;
    const showNoCert = anyFilter ? wantNoCert : false;

    const all = noVerify ? aidList(aunPath) : await aidListVerified(aunPath);
    const aids = all.filter(a =>
      (showMine && a.category === 'mine') ||
      (showBroken && a.category === 'broken') ||
      (showPeerCert && a.category === 'peer-cert') ||
      (showNoCert && a.category === 'no-cert')
    );

    if (formatJson) {
      console.log(JSON.stringify(aids, null, 2));
      return;
    }
    if (aids.length === 0) {
      console.log('无匹配 AID');
      return;
    }
    console.log(`本地 AID${noVerify ? '（静态扫描，未实测）' : ''}（${aunPath ?? resolveRoot()}）:`);
    for (const a of aids) {
      const keyIcon = a.hasPrivateKey ? '🔑' : '  ';
      let signIcon = '  ';
      // --no-verify 时 signVerified 始终为 null，用 canSign 作为静态近似
      const effectiveOk = noVerify ? a.canSign : a.signVerified === true;
      const effectiveFail = noVerify ? (a.hasPrivateKey && !a.canSign) : (a.hasPrivateKey && a.signVerified === false);
      if (effectiveOk) signIcon = '✅';
      else if (a.hasPrivateKey && a.certExpired) signIcon = '⌛';
      else if (effectiveFail) signIcon = '❌';
      const certIcon = a.hasCert ? '📜' : '  ';
      const mdIcon = a.hasAgentMd ? '📄' : '  ';
      const tail = !noVerify && a.signVerified === false && a.signError && !(a.keyMatchesCert === false || a.certExpired || !a.hasPrivateKey || !a.hasCert)
        ? `  (${a.signError})` : '';
      console.log(`  ${keyIcon} ${signIcon} ${certIcon} ${mdIcon}  ${a.aid}${tail}`);
    }
    console.log('\n🔑=私钥  ✅=可签名/验签  ❌=不可签名  ⌛=证书过期  📜=公钥证书  📄=agent.md');
    return;
  }

  if (sub === 'show') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw aid show <aid> [--format json]

查看本地 AID 详情：私钥/证书/agent.md 状态、签名能力实测。`);
      return;
    }
    const aid = args[1];
    if (!aid) {
      console.error('用法: evolclaw aid show <aid>');
      process.exit(1);
    }
    const info = await aidShow(aid, { aunPath });
    if (formatJson) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    console.log(`AID: ${info.aid}`);
    console.log(`  私钥: ${info.hasPrivateKey ? '有' : '无'}`);
    console.log(`  agent.md: ${info.hasAgentMd ? '有' : '无'}`);
    if (info.hasAgentMd) {
      const sigLabel = info.agentMdSignature === 'verified' ? '✓ 已验签'
        : info.agentMdSignature === 'unsigned' ? '⚠ 未签名'
        : info.agentMdSignature === 'invalid' ? `✗ 签名无效${info.agentMdSignatureReason ? ': ' + info.agentMdSignatureReason : ''}`
        : '? 未知';
      console.log(`  签名状态: ${sigLabel}`);
    }
    console.log(`  证书到期: ${info.certExpiresAt ?? '无证书'}${info.certExpired ? ' (已过期!)' : ''}`);
    if (info.certSubject) console.log(`  证书主体: ${info.certSubject}`);
    if (info.keyMatchesCert === false) console.log(`  密钥/证书: ✗ 公钥不匹配（cert.pem 与 key.json 公钥不一致）`);
    else if (info.keyMatchesCert === true) console.log(`  密钥/证书: ✓ 公钥一致`);
    if (info.signVerified === true) console.log(`  可签名/验签: ✓ 实测通过`);
    else if (info.signVerified === false) console.log(`  可签名/验签: ✗ 失败${info.signError ? `（${info.signError}）` : ''}`);
    else console.log(`  可签名/验签: ? 未知`);
    return;
  }

  if (sub === 'new') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw aid new <完整AID> [--force]

创建新 AID 身份：生成 ECDSA 密钥对、向 Issuer 申请证书、构建并上传初始 agent.md。

选项:
  --force    强制重新注册，覆盖已存在的身份（即使签名验证失败）

例: evolclaw aid new reviewer.agentid.pub
    evolclaw aid new reviewer.agentid.pub --force`);
      return;
    }
    const aid = args[1];
    const force = args.includes('--force');
    if (!aid) {
      console.error('用法: evolclaw aid new <完整AID> [--force]\n例: evolclaw aid new reviewer.agentid.pub');
      process.exit(1);
    }
    if (!isValidAid(aid)) {
      console.error(`❌ 无效 AID 格式: ${aid}`);
      process.exit(1);
    }

    try {
      const result = await aidCreate(aid, { aunPath, force });

      if (!result.alreadyExisted) {
        const content = buildInitialAgentMd({ aid });
        try {
          await agentmdPut(content, { aid, aunPath });
          console.log('✓ agent.md 已发布');
        } catch (e: any) {
          console.warn(`⚠ agent.md 发布失败（首次连接将自动重试）: ${String(e.message || e).slice(0, 100)}`);
        }
      }
      try { await result.client.close(); } catch {}
      try { result.store?.close(); } catch {}

      const verb = result.alreadyExisted ? '已存在且有效' : (force ? '已重新创建' : '已创建');
      console.log(`✓ ${aid} ${verb}`);
      console.log('  如需上线 AUN 通道，运行 evolclaw agent new ' + aid);
    } catch (e: any) {
      if (e.code === 'AID_INVALID') {
        console.error(`❌ ${e.message}`);
        process.exit(1);
      }
      if (e.code === -32052 || e.constructor?.name === 'IdentityConflictError') {
        console.error(`❌ AID ${aid} 已在服务端注册，但本地密钥无法匹配。\n` +
          `该 AID 可能由其他设备创建，无法在本地恢复。请选择其他名称。`);
        process.exit(1);
      }
      throw e;
    }
    return;
  }

  if (sub === 'delete') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw aid delete <子命令>

单个删除:
  evolclaw aid delete <aid>           删除指定 AID 的本地数据（无网络注销）

批量删除（默认 dry-run，加 --yes 才真删）:
  evolclaw aid delete --orphan        删除所有"无私钥"的本地缓存（外部 AID）
  evolclaw aid delete --no-cert       删除所有"无私钥也无公钥证书"的目录
                                       条件：!hasPrivateKey && !hasCert
                                       这些目录最多只剩 agent.md 或 SQLite 残留，
                                       对验签和加密通信都没用，删除安全。
  evolclaw aid delete --unrecoverable 删除所有不可恢复的 AID
                                       条件：本地 sign+verify 实测失败
                                       且 PKI 探测确认云端公钥也不等本地 key.json

选项:
  --yes              跳过 dry-run，立即执行
  --skip-pki         --unrecoverable 时跳过 PKI 探测，仅依据本地 sign+verify 失败判断（危险，可能误删可恢复 AID）
  --format json      输出 JSON 格式

示例:
  evolclaw aid delete old.agentid.pub
  evolclaw aid delete --orphan                列出会被清理的孤儿
  evolclaw aid delete --orphan --yes          实际清理
  evolclaw aid delete --no-cert               列出无证书孤儿目录
  evolclaw aid delete --no-cert --yes         实际清理
  evolclaw aid delete --unrecoverable         联网探测后列出无救 AID
  evolclaw aid delete --unrecoverable --yes`);
      return;
    }

    const yes = args.includes('--yes');
    const skipPki = args.includes('--skip-pki');
    const orphan = args.includes('--orphan');
    const noCert = args.includes('--no-cert');
    const unrecoverable = args.includes('--unrecoverable');

    const modes = [orphan, noCert, unrecoverable].filter(Boolean).length;
    if (modes > 1) {
      console.error('❌ --orphan / --no-cert / --unrecoverable 互斥，不能同时使用');
      process.exit(1);
    }

    // 单个 aid 删除：保留原有行为
    if (modes === 0) {
      const aid = args[1];
      if (!aid) {
        console.error('用法: evolclaw aid delete <aid>\n     evolclaw aid delete --orphan | --no-cert | --unrecoverable [--yes]\n     evolclaw aid delete --help   查看完整用法');
        process.exit(1);
      }
      const deleted = aidDelete(aid, { aunPath });
      if (deleted) {
        console.log(`✓ ${aid} 已删除`);
      } else {
        console.error(`❌ 本地不存在: ${aid}`);
        process.exit(1);
      }
      return;
    }

    // 批量模式：先选出候选
    const { probePkiRecoverability } = await import('../aun/aid/index.js');

    const candidates: { aid: string; reason: string; pki?: string }[] = [];

    if (orphan) {
      const aids = aidList(aunPath);
      for (const a of aids) {
        if (!a.hasPrivateKey) candidates.push({ aid: a.aid, reason: 'no private key (external AID cache)' });
      }
    } else if (noCert) {
      const aids = aidList(aunPath);
      for (const a of aids) {
        if (!a.hasPrivateKey && !a.hasCert) {
          const traits = [a.hasAgentMd ? 'agent.md' : null].filter(Boolean).join(', ');
          candidates.push({ aid: a.aid, reason: `no private key, no cert${traits ? ` (only: ${traits})` : ''}` });
        }
      }
    } else {
      // unrecoverable: 必须先做 sign+verify 实测
      if (!formatJson) console.log('扫描中: 本地签名/验签实测...');
      const aids = await aidListVerified(aunPath);
      const localBroken = aids.filter(a => a.hasPrivateKey && a.signVerified === false);

      if (skipPki) {
        for (const a of localBroken) {
          candidates.push({ aid: a.aid, reason: `sign+verify failed (${a.signError ?? 'unknown'}) [--skip-pki: 未联网验证]` });
        }
      } else {
        if (!formatJson) console.log(`扫描中: 对 ${localBroken.length} 个本地损坏 AID 做 PKI 探测...`);
        for (const a of localBroken) {
          const r = await probePkiRecoverability(a.aid, { aunPath });
          if (r.kind === 'unrecoverable') {
            candidates.push({ aid: a.aid, reason: `local broken; PKI: ${r.reason}`, pki: 'unrecoverable' });
          } else if (r.kind === 'no-server-record') {
            candidates.push({ aid: a.aid, reason: `local broken; PKI: ${r.reason}`, pki: 'no-server-record' });
          } else {
            // recoverable / no-key / unknown 一律保守不删
            if (!formatJson) console.log(`  · 跳过 ${a.aid}: PKI=${r.kind}${('reason' in r) ? ' — ' + r.reason : ''}`);
          }
        }
      }
    }

    if (formatJson) {
      console.log(JSON.stringify({
        mode: orphan ? 'orphan' : noCert ? 'no-cert' : 'unrecoverable',
        dryRun: !yes,
        skipPki: unrecoverable ? skipPki : undefined,
        candidates,
      }, null, 2));
      if (yes) {
        for (const c of candidates) aidDelete(c.aid, { aunPath });
      }
      return;
    }

    if (candidates.length === 0) {
      console.log(orphan ? '✓ 无孤儿 AID' : noCert ? '✓ 无无证书孤儿目录' : '✓ 无不可恢复 AID');
      return;
    }

    console.log(`\n${yes ? '将删除' : '候选删除（dry-run）'}：${candidates.length} 个 AID`);
    for (const c of candidates) {
      console.log(`  - ${c.aid}`);
      console.log(`      ${c.reason}`);
    }

    if (!yes) {
      console.log('\n（dry-run，未真删除。加 --yes 执行真删。）');
      return;
    }

    let ok = 0;
    let fail = 0;
    for (const c of candidates) {
      const deleted = aidDelete(c.aid, { aunPath });
      if (deleted) { console.log(`  ✓ 删除 ${c.aid}`); ok++; }
      else         { console.log(`  ✗ 失败 ${c.aid}（已不存在?）`); fail++; }
    }
    console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
    return;
  }

  if (sub === 'lookup') {
    if (wantsHelp(args)) {
      console.log(`用法: evolclaw aid lookup <aid> [--format json]

远程探测 AID：是否注册、所在网关、是否有 agent.md（不验签，仅获取）。`);
      return;
    }
    const aid = args[1];
    if (!aid) {
      console.error('用法: evolclaw aid lookup <aid>');
      process.exit(1);
    }
    if (!isValidAid(aid)) {
      console.error(`❌ 无效 AID 格式: ${aid}`);
      process.exit(1);
    }
    const result = await aidLookup(aid);
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.exists) {
      console.log(`✓ ${aid} 已注册`);
      if (result.gateway) console.log(`  网关: ${result.gateway}`);
      if (result.content) {
        const hasSig = result.content.includes('AUN-SIGNATURE');
        console.log(`  签名: ${hasSig ? '有（未验证，如需验证请用 evolclaw aid agentmd get ' + aid + '）' : '无'}`);
        console.log('');
        console.log(result.content);
      }
    } else {
      console.log(`✗ ${aid} 未注册`);
      if (result.gateway) console.log(`  网关: ${result.gateway}`);
      if (result.error) console.log(`  原因: ${result.error}`);
    }
    return;
  }

  if (sub === 'agentmd') {
    const verb = args[1];
    const aid = args[2];

    if (!verb || isHelpFlag(verb) || wantsHelp(args)) {
      console.log(`用法: evolclaw aid agentmd <put|get> <aid> [--format json]

  put <aid>   读本地 agent.md → 用本地私钥签名 → 上传到 PKI
  get <aid>   从 PKI 下载 agent.md → 验签 → 持久化到本地`);
      return;
    }

    if (verb === 'put') {
      if (!aid) {
        console.error('用法: evolclaw aid agentmd put <aid>');
        process.exit(1);
      }
      if (!isValidAid(aid)) {
        console.error(`❌ 无效 AID 格式: ${aid}`);
        process.exit(1);
      }
      const localPath = agentMdPath(aid);
      if (!fs.existsSync(localPath)) {
        console.error(`❌ 本地无 agent.md: ${aid}`);
        process.exit(1);
      }
      const content = fs.readFileSync(localPath, 'utf-8');
      await agentmdPut(content, { aid, aunPath });
      if (formatJson) {
        console.log(JSON.stringify({ ok: true, aid, path: localPath }, null, 2));
      } else {
        console.log('✓ agent.md 已发布');
      }
      return;
    }

    if (verb === 'get') {
      if (!aid) {
        console.error('用法: evolclaw aid agentmd get <aid>');
        process.exit(1);
      }
      if (!isValidAid(aid)) {
        console.error(`❌ 无效 AID 格式: ${aid}`);
        process.exit(1);
      }
      try {
        const result = await agentmdGet(aid, { withVerification: true, aunPath });
        if (!result.content || !result.content.trim()) {
          console.log(`ℹ️ ${aid} 尚未设置 agent.md`);
          return;
        }
        if (formatJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.content);
          const v = result.verification;
          if (v.status === 'verified') {
            console.error(`✓ 签名验证通过`);
          } else if (v.status === 'invalid') {
            console.error(`⚠ 签名验证失败: ${v.reason ?? '未知原因'}`);
          } else {
            console.error(`ℹ️ 未签名`);
          }
        }
      } catch (e: any) {
        const msg = String(e.message || e);
        if (msg.includes('not found') || msg.includes('404')) {
          console.log(`ℹ️ ${aid} 尚未设置 agent.md`);
        } else {
          console.error(`❌ 获取失败: ${msg.slice(0, 100)}`);
          process.exit(1);
        }
      }
      return;
    }

    console.error(`未知子命令: aid agentmd ${verb ?? ''}\n用法: evolclaw aid agentmd [put|get] <aid>`);
    process.exit(1);
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw aid [list|show|new|delete|lookup|agentmd] <aid>`);
  process.exit(1);
}

// ==================== RPC ====================

export async function cmdRpc(args: string[]): Promise<void> {
  if (args.length === 0 || isHelpFlag(args[0])) {
    console.log(`用法: evolclaw rpc --as <aid> --params <params>

通用 AUN RPC 调用。

--params 自动判断输入形式:
  单行 JSON (以 { 开头)     → 单次调用
  多行 JSONL                → 逐行执行，失败即停
  文件路径 (文件存在)        → 读取文件内容作为 JSONL

每行 JSON 格式: {"method":"<namespace.method>","params":{...}}

Options:
  --app <name>   指定应用 slot（独立消费通道）。仅对 message.pull / group.pull
                 等消费类方法有意义——隔离 seq 游标与消息过滤；默认与 daemon 共享通道。

示例:
  evolclaw rpc --as alice.agentid.pub --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'
  evolclaw rpc --as alice.agentid.pub --params calls.jsonl`);
    return;
  }

  const asIdx = args.indexOf('--as');
  const paramsIdx = args.indexOf('--params');
  const aunPath = resolveAunPath(args);
  const appSlot = getArgValue(args, '--app');

  if (asIdx === -1 || asIdx + 1 >= args.length) {
    console.error('❌ 缺少 --as <aid>');
    process.exit(1);
  }
  if (paramsIdx === -1 || paramsIdx + 1 >= args.length) {
    console.error('❌ 缺少 --params <params>');
    process.exit(1);
  }

  const aid = args[asIdx + 1];
  const paramsRaw = args[paramsIdx + 1];

  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(aid)) {
    console.error(`❌ 无效 AID 格式: ${aid}`);
    process.exit(1);
  }

  // Determine input: file, single JSON, or multi-line JSONL
  let lines: string[];
  if (fs.existsSync(paramsRaw)) {
    lines = fs.readFileSync(paramsRaw, 'utf-8').split('\n').filter(l => l.trim());
  } else if (paramsRaw.includes('\n')) {
    lines = paramsRaw.split('\n').filter(l => l.trim());
  } else {
    lines = [paramsRaw];
  }

  // Parse calls
  const calls: Array<{ method: string; params: any }> = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!parsed.method) {
        console.error(`❌ 第 ${i + 1} 行缺少 "method" 字段`);
        process.exit(1);
      }
      calls.push({ method: parsed.method, params: parsed.params ?? {} });
    } catch (e: any) {
      console.error(`❌ 第 ${i + 1} 行 JSON 解析失败: ${e.message}`);
      process.exit(1);
    }
  }

  const { rpcCall, rpcBatch } = await import('../aun/rpc/index.js');

  if (calls.length === 1) {
    const result = await rpcCall(aid, calls[0].method, calls[0].params, { aunPath, slotId: appSlot });
    console.log(JSON.stringify(result));
  } else {
    const results = await rpcBatch(aid, calls, { aunPath, slotId: appSlot });
    for (const r of results) {
      console.log(JSON.stringify(r));
    }
  }
}

// ==================== Storage ====================

export async function cmdStorage(args: string[]): Promise<void> {
  const sub = args[0];
  const aunPath = resolveAunPath(args);
  const formatJson = getArgValue(args, '--format') === 'json';

  if (!sub || isHelpFlag(sub)) {
    console.log(`用法: evolclaw storage <command> <aid> [options]

Commands:
  upload <aid> <local-file> <remote-path> [--public]   上传文件（默认私有）
  download <aid> <url> [local-path]                    下载文件
  ls <aid> [prefix]                                    列文件
  rm <aid> <remote-path>                               删文件
  quota <aid>                                          查配额

<url> 格式: [https://]<owner-aid>/<path>

示例:
  evolclaw storage upload myaid.agentid.pub ./doc.txt notes/doc.txt
  evolclaw storage upload myaid.agentid.pub ./pic.png images/pic.png --public
  evolclaw storage download myaid.agentid.pub myaid.agentid.pub/notes/doc.txt ./doc.txt
  evolclaw storage download myaid.agentid.pub bob.agentid.pub/public/file.pdf ./file.pdf
  evolclaw storage ls myaid.agentid.pub notes/
  evolclaw storage rm myaid.agentid.pub notes/doc.txt
  evolclaw storage quota myaid.agentid.pub`);
    return;
  }

  const aid = args[1];
  if (!aid) {
    console.error('❌ 缺少 <aid> 参数');
    process.exit(1);
  }

  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(aid)) {
    console.error(`❌ 无效 AID 格式: ${aid}`);
    process.exit(1);
  }

  const { storageUpload, storageDownload, storageLs, storageRm, storageQuota } = await import('../aun/storage/index.js');

  if (sub === 'upload') {
    const localFile = args[2];
    const remotePath = args[3];
    const isPublic = args.includes('--public');

    if (!localFile || !remotePath) {
      console.error('用法: evolclaw storage upload <aid> <local-file> <remote-path> [--public]');
      process.exit(1);
    }
    if (!fs.existsSync(localFile)) {
      console.error(`❌ 文件不存在: ${localFile}`);
      process.exit(1);
    }

    const result = await storageUpload(aid, localFile, remotePath, { isPublic, aunPath });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify({ ok: false, error: result.error })); }
      else { console.error(`❌ 上传失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify({ ok: true, objectKey: remotePath, isPublic, ref: `${aid}/${remotePath}`, publicUrl: result.publicUrl ?? null }));
    } else {
      console.log(`✓ 已上传: ${remotePath}${isPublic ? ' (公开)' : ''}`);
      if (result.publicUrl) {
        console.log(`  🔗 访问: ${result.publicUrl}`);
      } else {
        console.log(`  引用: ${aid}/${remotePath}`);
      }
      console.log(`  下载: evolclaw storage download ${aid} ${aid}/${remotePath}`);
    }
    return;
  }

  if (sub === 'download') {
    const url = args[2];
    const localPath = args[3];

    if (!url) {
      console.error('用法: evolclaw storage download <aid> <url> [local-path]');
      process.exit(1);
    }

    const result = await storageDownload(aid, url, localPath, { aunPath });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify({ ok: false, error: result.error })); }
      else { console.error(`❌ 下载失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify({ ok: true, localPath: result.localPath, size: result.size }));
    } else {
      console.log(`✓ 已下载: ${result.localPath} (${result.size} bytes)`);
    }
    return;
  }

  if (sub === 'ls') {
    const prefix = args[2] || '';
    const result = await storageLs(aid, prefix, { aunPath });
    if (!result.ok) {
      console.error(`❌ 列文件失败: ${JSON.stringify(result.error)}`);
      process.exit(1);
    }
    const objects = result.result?.objects || result.result || [];
    if (Array.isArray(objects) && objects.length === 0) {
      console.log('(空)');
    } else {
      console.log(JSON.stringify(objects, null, 2));
    }
    return;
  }

  if (sub === 'rm') {
    const remotePath = args[2];
    if (!remotePath) {
      console.error('用法: evolclaw storage rm <aid> <remote-path>');
      process.exit(1);
    }
    const result = await storageRm(aid, remotePath, { aunPath });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify({ ok: false, error: result.error })); }
      else { console.error(`❌ 删除失败: ${JSON.stringify(result.error)}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify({ ok: true, objectKey: remotePath }));
    } else {
      console.log(`✓ 已删除: ${remotePath}`);
    }
    return;
  }

  if (sub === 'quota') {
    const result = await storageQuota(aid, { aunPath });
    if (!result.ok) {
      console.error(`❌ 查询配额失败: ${JSON.stringify(result.error)}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result.result, null, 2));
    return;
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw storage [upload|download|ls|rm|quota]`);
  process.exit(1);
}

// ==================== Msg ====================

export async function cmdMsg(args: string[]): Promise<void> {
  const sub = args[0];
  const aunPath = resolveAunPath(args);
  const formatJson = getArgValue(args, '--format') === 'json';
  const appIdx = args.indexOf('--app');
  const appSlot = appIdx >= 0 ? args[appIdx + 1] : undefined;

  if (!sub || isHelpFlag(sub)) {
    console.log(`用法: evolclaw msg <command> <from-aid> [args...] [options]

Commands:
  send <from> <to> <text>                              发送文本
  send <from> <to> --text-from-file <path>             从文件读取文本内容
  send <from> <to> --file <path> [--as <type>]         发送文件（image|video|voice|file）
  send <from> <to> --link <url> [--title T]            发送链接卡片
  send <from> <to> --payload <json>                    发送自定义 payload
  pull <from> [--after-seq N] [--limit N]              拉取收件箱
  ack <from> <seq> [--app <name>]                      确认已读
  recall <from> <message-id> [<message-id>...]         撤回消息
  online <from> <target-aid> [<target-aid>...]         查询在线状态

Options:
  --text-from-file <path>  从文件读取文本（UTF-8），用于超长消息或避免 Shell 转义
  --app <name>          指定应用 slot（独立消费通道，不影响 daemon）
  --format json         输出 JSON 格式
  --encrypt             启用端到端加密（密文发送）
  --no-encrypt          强制明文发送（优先于 --encrypt）
  --thread <id>         指定话题 ID（用于多话题路由）
  --return <required|none> 跨会话回流策略（一期仅支持 required；跨会话默认 required）
  --content-type <mime> 显式覆盖 MIME（仅 --file 模式）
  --text <说明>          附件说明文字（仅 --file 模式）
  --transcript <text>   语音转写（仅 --as voice）
  --                    end-of-options：其后所有参数按正文处理
                        （用于发送恰好等于某 flag 的文本，如 send a b -- --encrypt）

示例:
  evolclaw msg send alice.agentid.pub bob.agentid.pub "hello"
  evolclaw msg send alice.agentid.pub bob.agentid.pub --text-from-file long-message.txt
  evolclaw msg send alice.agentid.pub bob.agentid.pub "讨论项目A" --thread "project-A"
  evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./pic.png
  evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./demo.mp4 --as video
  evolclaw msg send alice.agentid.pub bob.agentid.pub --link https://example.com --title "AUN"
  evolclaw msg pull alice.agentid.pub --app my-bot
  evolclaw msg ack alice.agentid.pub 42 --app my-bot
  evolclaw msg recall alice.agentid.pub msg-uuid-1 msg-uuid-2
  evolclaw msg online alice.agentid.pub bob.agentid.pub carol.agentid.pub`);
    return;
  }

  const from = args[1];
  if (!from) {
    console.error('❌ 缺少 <from-aid> 参数');
    process.exit(1);
  }
  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(from)) {
    console.error(`❌ 无效 AID 格式: ${from}`);
    process.exit(1);
  }

  const { msgSend, msgPull, msgAck, msgRecall, msgOnline } = await import('../aun/msg/index.js');
  const commonOpts = { aunPath, slotId: appSlot };

  if (sub === 'send') {
    const to = args[2];
    if (!to) {
      console.error('用法: evolclaw msg send <from> <to> <text|--file ...|--link ...|--payload ...>');
      process.exit(1);
    }
    if (!isValidAid(to)) {
      console.error(`❌ 无效目标 AID: ${to}`);
      process.exit(1);
    }

    const fileVal = getArgValue(args, '--file');
    const textFromFileVal = getArgValue(args, '--text-from-file');
    const linkVal = getArgValue(args, '--link');
    const payloadVal = getArgValue(args, '--payload');
    let body: any;

    // 检查互斥参数
    const exclusiveModes = [fileVal, textFromFileVal, linkVal, payloadVal].filter(Boolean);
    if (exclusiveModes.length > 1) {
      console.error('❌ --file, --text-from-file, --link, --payload 互斥，只能指定一个');
      process.exit(1);
    }

    if (fileVal) {
      body = {
        mode: 'file',
        filePath: fileVal,
        as: getArgValue(args, '--as'),
        contentType: getArgValue(args, '--content-type'),
        text: getArgValue(args, '--text'),
        transcript: getArgValue(args, '--transcript'),
      };
    } else if (textFromFileVal) {
      // 从文件读取文本内容
      if (!fs.existsSync(textFromFileVal)) {
        console.error(`❌ 文件不存在: ${textFromFileVal}`);
        process.exit(1);
      }
      let text: string;
      try {
        text = fs.readFileSync(textFromFileVal, 'utf-8');
      } catch (e: any) {
        console.error(`❌ 读取文件失败: ${e.message}`);
        process.exit(1);
      }
      if (!text) {
        console.error('❌ 文件内容为空');
        process.exit(1);
      }
      body = { mode: 'text', text };
    } else if (linkVal) {
      body = {
        mode: 'link',
        url: linkVal,
        title: getArgValue(args, '--title'),
        description: getArgValue(args, '--description'),
      };
    } else if (payloadVal) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(payloadVal); }
      catch (e: any) {
        console.error(`❌ --payload 解析失败: ${e.message}`);
        process.exit(1);
      }
      body = { mode: 'payload', payload: parsed };
    } else {
      const text = collectPositional(args, 3).join(' ');
      if (!text) {
        console.error('❌ 缺少消息内容（文本或 --file/--text-from-file/--link/--payload）');
        process.exit(1);
      }
      body = { mode: 'text', text };
    }

    // 加密态：--encrypt 密文，--no-encrypt 明文，都不带默认明文（人类终端直用即此）。
    // 模型自主发送时由系统提示规则要求按入站消息加密态显式带参。--no-encrypt 优先于 --encrypt。
    const encrypt = args.includes('--encrypt') && !args.includes('--no-encrypt');
    const thread = getArgValue(args, '--thread');
    const returnPolicyRaw = getArgValue(args, '--return');
    if (returnPolicyRaw && returnPolicyRaw !== 'required' && returnPolicyRaw !== 'none') {
      console.error(`❌ --return 仅支持 required|none: ${returnPolicyRaw}`);
      process.exit(1);
    }

    // 文件上传进度展示（非 JSON 输出时）。仅在大文件降级到 HTTP PUT 阶段会逐块更新。
    let lastPctShown = -1;
    const onUploadProgress = formatJson ? undefined : (info: { phase: string; bytes: number; total: number }) => {
      if (info.phase === 'inline') return; // 内联阶段不分块，跳过
      if (info.phase === 'http-put') {
        const pct = info.total > 0 ? Math.floor((info.bytes / info.total) * 100) : 0;
        if (pct === lastPctShown && info.bytes < info.total) return;
        lastPctShown = pct;
        const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
        const eol = info.bytes >= info.total ? '\n' : '\r';
        process.stderr.write(`  ⏫ uploading: ${pct}% (${mb(info.bytes)}/${mb(info.total)} MB)${eol}`);
      } else if (info.phase === 'session-create') {
        process.stderr.write('  ⏫ requesting upload session...\n');
      } else if (info.phase === 'session-complete') {
        process.stderr.write('  ⏫ finalizing upload...\n');
      }
    };

    const result = await msgSend({ from, to, body, encrypt, thread, returnPolicy: returnPolicyRaw as 'required' | 'none' | undefined, onUploadProgress, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ 发送失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      if (result.handoff_id) console.log(`✓ 已排队 handoff ${result.handoff_id}`);
      else console.log(`✓ 已发送 ${result.message_id ?? ''} seq=${result.seq ?? '-'} status=${result.status ?? '-'}`);
    }
    return;
  }

  if (sub === 'pull') {
    if (!appSlot) {
      console.warn('⚠ 警告: 未传 --app，当前与 daemon 共享 evolclaw 消费通道。pull 会看到/影响 daemon 的消息消费；如需独立消费请用 --app <name>');
    }
    const afterSeqStr = getArgValue(args, '--after-seq');
    const limitStr = getArgValue(args, '--limit');
    const afterSeq = afterSeqStr !== undefined ? Number(afterSeqStr) : undefined;
    const limit = limitStr !== undefined ? Number(limitStr) : undefined;
    if (afterSeq !== undefined && !Number.isFinite(afterSeq)) {
      console.error(`❌ --after-seq 必须是数字: ${afterSeqStr}`);
      process.exit(1);
    }
    if (limit !== undefined && !Number.isFinite(limit)) {
      console.error(`❌ --limit 必须是数字: ${limitStr}`);
      process.exit(1);
    }

    const result = await msgPull({ from, afterSeq, limit, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ 拉取失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`✓ ${result.count} 条消息，latest_seq=${result.latest_seq}`);
      for (const m of result.messages) {
        const text = (m.payload as any)?.text ?? JSON.stringify(m.payload).slice(0, 80);
        console.log(`  [${m.seq}] ${m.from}: ${text}`);
      }
      if (result.ephemeral_dropped_count && result.ephemeral_dropped_count > 0) {
        console.log(`  (临时消息淘汰: ${result.ephemeral_dropped_count} 条)`);
      }
    }
    return;
  }

  if (sub === 'ack') {
    const seqStr = args[2];
    if (!seqStr) {
      console.error('用法: evolclaw msg ack <from> <seq> [--app <name>]');
      process.exit(1);
    }
    const seq = Number(seqStr);
    if (!Number.isFinite(seq)) {
      console.error(`❌ seq 必须是数字: ${seqStr}`);
      process.exit(1);
    }
    if (!appSlot) {
      console.warn('⚠ 警告: 未传 --app，ack 将推进与 daemon 共享的 evolclaw 消费游标，可能影响 daemon 收消息；如需独立请用 --app <name>');
    }

    const result = await msgAck({ from, seq, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ack 失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`✓ ack_seq=${result.ack_seq}`);
    }
    return;
  }

  if (sub === 'recall') {
    const messageIds = collectPositional(args, 2);
    if (messageIds.length === 0) {
      console.error('用法: evolclaw msg recall <from> <message-id> [<message-id>...]');
      process.exit(1);
    }

    const result = await msgRecall({ from, messageIds, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ recall 失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`✓ 受理 ${result.accepted}，撤回 ${result.recalled}`);
      if (result.errors && result.errors.length > 0) {
        for (const e of result.errors) {
          console.log(`  失败 ${e.message_id}: ${e.error}`);
        }
      }
    }
    return;
  }

  if (sub === 'online') {
    const targets = collectPositional(args, 2);
    if (targets.length === 0) {
      console.error('用法: evolclaw msg online <from> <target-aid> [<target-aid>...]');
      process.exit(1);
    }
    for (const t of targets) {
      if (!isValidAid(t)) {
        console.error(`❌ 无效 AID: ${t}`);
        process.exit(1);
      }
    }

    const result = await msgOnline({ from, targets, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ 查询失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      for (const [aid, online] of Object.entries(result.online)) {
        console.log(`  ${online ? '🟢' : '⚫'} ${aid}`);
      }
    }
    return;
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw msg [send|pull|ack|recall|online]`);
  process.exit(1);
}

// ==================== Group ====================

export async function cmdGroup(args: string[]): Promise<void> {
  const sub = args[0];
  const aunPath = resolveAunPath(args);
  const formatJson = getArgValue(args, '--format') === 'json';
  const appIdx = args.indexOf('--app');
  const appSlot = appIdx >= 0 ? args[appIdx + 1] : undefined;

  if (!sub || isHelpFlag(sub)) {
    console.log(`用法: evolclaw group <command> <from-aid> [args...] [options]

消息:
  send <from> <group-id> <text>                        发送群文本
  send <from> <group-id> --file <path> [--as <type>]   发送群文件
  send <from> <group-id> --payload <json>              发送自定义 payload
  pull <from> <group-id> [--after-seq N] [--limit N]   拉取群消息
  ack <from> <group-id> <seq> [--app <name>]           确认已读

群管理:
  create <from> <name> [--visibility public|private] [--description D] [--join-mode M]  创建群
  list <from> [--size N]                                列出我加入的群
  info <from> <group-id>                                查看群详情
  update <from> <group-id> [--name N] [--description D] 修改群信息
  dissolve <from> <group-id>                            解散群
  suspend <from> <group-id>                             暂停群
  resume <from> <group-id>                              恢复群
  rules <from> <group-id> get                          读取已发布群规则文件 /rules.md
  rules <from> <group-id> set <file>                   上传并发布群规则文件
  rules <from> <group-id> publish                      发布当前群空间 /rules.md
  rules <from> <group-id> [--mode M] [--question Q] [--max-pending N]  查看/更新入群规则

成员:
  join <from> <group-id> [--message M] [--answer A]    申请加入
  leave <from> <group-id>                              退出群
  invite <from> <group-id> <member-aid> [<member-aid>...]   邀请成员
  kick <from> <group-id> <member-aid>                  踢出成员
  members <from> <group-id> [--page N] [--size N]      列出群成员
  online <from> <group-id>                             查看在线成员
  role <from> <group-id> <member-aid> <admin|member>   设置成员角色
  owner <from> <group-id> <new-owner-aid>               转让群主
  ban <from> <group-id> [<member-aid>] [--duration N]   封禁成员；不带 member-aid 时列出封禁
  unban <from> <group-id> <member-aid>                  解封成员

Options:
  --app <name>          指定应用 slot（独立消费通道，不影响 daemon）
  --format json         输出 JSON 格式
  --encrypt             启用端到端加密（仅 send）
  --no-encrypt          强制明文发送（优先于 --encrypt；仅 send）
  --mention <aid>       发送时 @ 某个成员（可多次，或用逗号分隔多个 aid）
  --mention-all         发送时 @ 所有人
  --                    end-of-options：其后所有参数按正文处理
                        （用于发送恰好等于某 flag 的文本，如 send a g -- --encrypt）

示例:
  evolclaw group create alice.agentid.pub "Dev Team" --visibility private
  evolclaw group send alice.agentid.pub g-dev.agentid.pub "hello team"
  evolclaw group send alice.agentid.pub g-dev.agentid.pub "@bob 看下 PR" --mention bob.agentid.pub
  evolclaw group send alice.agentid.pub g-dev.agentid.pub --file ./arch.png
  evolclaw group rules alice.agentid.pub g-dev.agentid.pub set ./rules.md
  evolclaw group invite alice.agentid.pub g-dev.agentid.pub bob.agentid.pub carol.agentid.pub
  evolclaw group members alice.agentid.pub g-dev.agentid.pub`);
    return;
  }

  const from = args[1];
  if (!from) {
    console.error('❌ 缺少 <from-aid> 参数');
    process.exit(1);
  }
  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(from)) {
    console.error(`❌ 无效 AID 格式: ${from}`);
    process.exit(1);
  }

  const {
    groupSend, groupPull, groupAck,
    groupCreate, groupInfo, groupList, groupUpdate, groupDissolve,
    groupSuspend, groupResume,
    groupJoin, groupLeave, groupInvite, groupKick, groupMembers, groupOnline,
    groupSetRole, groupTransferOwner, groupBan, groupUnban, groupBanlist,
    groupRules, groupUpdateRules,
    groupRulesFileGet, groupRulesFileSet, groupRulesFilePublish,
  } = await import('../aun/msg/index.js');
  const commonOpts = { aunPath, slotId: appSlot };

  // 通用 group_id 提取（第三参数）
  const requireGroupId = (): string => {
    const gid = args[2];
    if (!gid) {
      console.error(`❌ 缺少 <group-id> 参数`);
      process.exit(1);
    }
    return gid;
  };

  // 收集 --mention（可多次；每次的值支持逗号分隔多个 aid）
  const collectMentions = (): Array<Record<string, unknown>> => {
    const mentions: Array<Record<string, unknown>> = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--mention') continue;
      const val = args[i + 1];
      if (val === undefined || val.startsWith('--')) {
        console.error(`❌ --mention 后面缺少 <aid>`);
        process.exit(1);
      }
      for (const aid of val.split(',').map(s => s.trim()).filter(Boolean)) {
        if (!isValidAid(aid)) {
          console.error(`❌ --mention 的 aid 无效: ${aid}`);
          process.exit(1);
        }
        mentions.push({ aid });
      }
    }
    if (args.includes('--mention-all')) {
      mentions.push({ scope: 'all' });
    }
    return mentions;
  };

  // 输出辅助
  const outputResult = (result: any, successHuman: () => void) => {
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      successHuman();
    }
  };

  const parseNumberFlag = (flag: string, label: string): number | undefined => {
    const value = getArgValue(args, flag);
    if (value === undefined) return undefined;
    if (value.startsWith('--')) {
      console.error(`❌ ${label} 后面缺少数值`);
      process.exit(1);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      console.error(`❌ ${label} 必须是数字: ${value}`);
      process.exit(1);
    }
    return parsed;
  };

  const requireFlagValue = (flag: string, label: string): string => {
    const value = getArgValue(args, flag);
    if (value === undefined || value.startsWith('--')) {
      console.error(`❌ ${label} 后面缺少值`);
      process.exit(1);
    }
    return value;
  };

  const prettyJson = (value: unknown, indent = '  '): string => {
    const json = JSON.stringify(value ?? null, null, 2) ?? 'null';
    return json.split('\n').map(line => indent + line).join('\n');
  };

  const renderBanItem = (item: unknown): string => {
    if (!item || typeof item !== 'object') return String(item);
    const data = item as Record<string, unknown>;
    const aid = String(data.aid ?? data.member_aid ?? data.target_aid ?? data.user_id ?? data.peer_id ?? '-');
    const reason = data.reason ?? data.note ?? data.message ?? data.remark;
    const until = data.until ?? data.expire_at ?? data.expires_at ?? data.ban_until ?? data.duration_seconds;
    const parts = [aid];
    if (until !== undefined && until !== null && until !== '') parts.push(`until=${until}`);
    if (reason !== undefined && reason !== null && reason !== '') parts.push(`reason=${reason}`);
    return parts.join(' ');
  };

  // ---- 消息 ----

  if (sub === 'send') {
    const groupId = requireGroupId();
    const fileVal = getArgValue(args, '--file');
    const payloadVal = getArgValue(args, '--payload');
    let body: any;

    if (fileVal) {
      body = {
        mode: 'file',
        filePath: fileVal,
        as: getArgValue(args, '--as'),
        contentType: getArgValue(args, '--content-type'),
        text: getArgValue(args, '--text'),
        transcript: getArgValue(args, '--transcript'),
      };
    } else if (payloadVal) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(payloadVal); }
      catch (e: any) {
        console.error(`❌ --payload 解析失败: ${e.message}`);
        process.exit(1);
      }
      body = { mode: 'payload', payload: parsed };
    } else {
      const text = collectPositional(args, 3).join(' ');
      if (!text) {
        console.error('❌ 缺少消息内容（文本或 --file/--payload）');
        process.exit(1);
      }
      body = { mode: 'text', text };
    }

    const mentions = collectMentions();
    // --encrypt 密文，--no-encrypt 明文，都不带默认明文。--no-encrypt 优先。
    const encryptGroup = args.includes('--encrypt') && !args.includes('--no-encrypt');
    const result = await groupSend({ from, groupId, body, mentions: mentions.length ? mentions : undefined, encrypt: encryptGroup, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 已发送 message_id=${r.message?.message_id ?? '-'} seq=${r.message?.seq ?? '-'}`);
    });
    return;
  }

  if (sub === 'pull') {
    const groupId = requireGroupId();
    if (!appSlot) {
      console.warn('⚠ 警告: 未传 --app，当前与 daemon 共享 evolclaw 消费通道。pull 会看到/影响 daemon 的消息消费；如需独立消费请用 --app <name>');
    }
    const afterSeqStr = getArgValue(args, '--after-seq');
    const limitStr = getArgValue(args, '--limit');
    const afterSeq = afterSeqStr !== undefined ? Number(afterSeqStr) : undefined;
    const limit = limitStr !== undefined ? Number(limitStr) : undefined;

    const result = await groupPull({ from, groupId, afterSeq, limit, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ ${r.messages.length} 条消息，latest_seq=${r.latest_message_seq}${r.has_more ? '（还有更多）' : ''}`);
      for (const m of r.messages) {
        const text = m.payload?.text ?? JSON.stringify(m.payload).slice(0, 80);
        console.log(`  [${m.seq}] ${m.sender_aid}: ${text}`);
      }
    });
    return;
  }

  if (sub === 'ack') {
    const groupId = requireGroupId();
    const seqStr = args[3];
    if (!seqStr) {
      console.error('用法: evolclaw group ack <from> <group-id> <seq> [--app <name>]');
      process.exit(1);
    }
    const seq = Number(seqStr);
    if (!Number.isFinite(seq)) {
      console.error(`❌ seq 必须是数字: ${seqStr}`);
      process.exit(1);
    }
    if (!appSlot) {
      console.warn('⚠ 警告: 未传 --app，ack 将推进与 daemon 共享的 evolclaw 消费游标，可能影响 daemon 收消息；如需独立请用 --app <name>');
    }

    const result = await groupAck({ from, groupId, seq, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ ack_seq=${r.ack_seq}`);
    });
    return;
  }

  // ---- 群管理 ----

  if (sub === 'create') {
    const name = args[2];
    if (!name) {
      console.error('用法: evolclaw group create <from> <name> [--visibility ...] [--description ...]');
      process.exit(1);
    }
    const visibility = getArgValue(args, '--visibility') as any;
    if (visibility && visibility !== 'public' && visibility !== 'private') {
      console.error(`❌ --visibility 必须是 public 或 private`);
      process.exit(1);
    }
    const result = await groupCreate({
      from,
      name,
      visibility,
      description: getArgValue(args, '--description'),
      joinMode: getArgValue(args, '--join-mode') as any,
      groupId: getArgValue(args, '--group-id'),
      ...commonOpts,
    });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 已创建群 ${r.group?.group_id}`);
      console.log(`  名称: ${r.group?.name}`);
      console.log(`  可见性: ${r.group?.visibility}`);
    });
    return;
  }

  if (sub === 'list') {
    const sizeStr = getArgValue(args, '--size');
    const size = sizeStr !== undefined ? Number(sizeStr) : undefined;
    const result = await groupList({ from, size, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      if (r.items.length === 0) {
        console.log('(没有加入任何群)');
        return;
      }
      console.log(`共 ${r.total} 个群:`);
      for (const g of r.items) {
        console.log(`  ${g.group_id}  ${g.name}  (${g.member_count ?? '?'} 人)`);
      }
    });
    return;
  }

  if (sub === 'info') {
    const groupId = requireGroupId();
    const result = await groupInfo({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      const g = (result as any).group;
      console.log(`Group: ${g.group_id}`);
      console.log(`  名称:     ${g.name}`);
      console.log(`  群主:     ${g.owner_aid}`);
      console.log(`  可见性:   ${g.visibility ?? '-'}`);
      console.log(`  状态:     ${g.status ?? '-'}`);
      console.log(`  成员数:   ${g.member_count ?? '-'}`);
      console.log(`  最新 seq: ${g.message_seq ?? '-'}`);
      if (g.description) console.log(`  描述:     ${g.description}`);
    });
    return;
  }

  if (sub === 'update') {
    const groupId = requireGroupId();
    const name = getArgValue(args, '--name');
    const description = getArgValue(args, '--description');
    if (name === undefined && description === undefined) {
      console.error('❌ 至少需要 --name 或 --description 之一');
      process.exit(1);
    }
    const result = await groupUpdate({ from, groupId, name, description, ...commonOpts });
    outputResult(result, () => {
      const g = (result as any).group;
      console.log(`✓ 已更新 ${g.group_id}`);
      console.log(`  名称: ${g.name}`);
    });
    return;
  }

  if (sub === 'dissolve') {
    const groupId = requireGroupId();
    const result = await groupDissolve({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 已解散 ${r.group_id} (${r.status})`);
    });
    return;
  }

  if (sub === 'suspend') {
    const groupId = requireGroupId();
    const result = await groupSuspend({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已暂停 ${groupId}`);
    });
    return;
  }

  if (sub === 'resume') {
    const groupId = requireGroupId();
    const result = await groupResume({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已恢复 ${groupId}`);
    });
    return;
  }

  if (sub === 'rules') {
    const groupId = requireGroupId();
    const action = args[3];
    const printRulesFileUsage = () => {
      console.log(`用法:
  evolclaw group rules <from> <group-id> get
  evolclaw group rules <from> <group-id> set <file>
  evolclaw group rules <from> <group-id> publish
  evolclaw group rules <from> <group-id> [--mode open|approval|invite_only|closed] [--question Q] [--max-pending N]

说明:
  get      读取当前已发布的群规则文件 /rules.md
  set      上传本地文件到群空间 /rules.md，发布 rules.content 元数据，并发送 group.rules.updated 通知
  publish  不上传文件，仅发布当前群空间 /rules.md 的元数据并发送通知

兼容:
  不带 get/set/publish 时仍使用旧的入群规则接口。`);
    };
    const printRulesFileState = (result: any, verb: 'get' | 'set' | 'publish') => {
      if (!result.ok) {
        if (formatJson) { console.log(JSON.stringify(result)); }
        else { console.error(`❌ ${result.error}`); }
        process.exit(1);
      }
      if (formatJson) {
        console.log(JSON.stringify(result));
        return;
      }

      if (verb === 'get' && result.status === 'ok') {
        process.stdout.write(String(result.content ?? ''));
        return;
      }

      if (result.status === 'ok') {
        console.log(`✓ 群规则已发布 ${result.group_id}:/rules.md`);
      } else {
        console.log(`群规则状态: ${result.status}`);
      }
      if (result.metadata) {
        console.log(`  元数据: path=${result.metadata.path} size=${result.metadata.size} mtimeMs=${result.metadata.mtimeMs}`);
      }
      if (result.remote) {
        console.log(`  远端: size=${result.remote.size ?? '-'} mtimeMs=${result.remote.mtimeMs ?? '-'}`);
      }
      if (result.group_index_etag) {
        console.log(`  group.index etag: ${result.group_index_etag}`);
      }
      if (result.notice) {
        if (result.notice.ok) console.log(`  通知: 已发送${result.notice.message_id ? ` message_id=${result.notice.message_id}` : ''}`);
        else console.warn(`  通知: 发送失败 ${result.notice.error ?? ''}`.trimEnd());
      }
      if (result.error) {
        console.log(`  错误: ${result.error}`);
      }
      if ((verb === 'set' || verb === 'publish') && result.status !== 'ok') {
        process.exit(1);
      }
    };

    if (action && isHelpFlag(action)) {
      printRulesFileUsage();
      return;
    }
    if (action === 'get') {
      const result = await groupRulesFileGet({ from, groupId, ...commonOpts });
      printRulesFileState(result, 'get');
      return;
    }
    if (action === 'set') {
      const filePath = args[4];
      if (!filePath || filePath.startsWith('--')) {
        console.error('❌ 缺少 <file> 参数');
        printRulesFileUsage();
        process.exit(1);
      }
      const result = await groupRulesFileSet({ from, groupId, filePath, ...commonOpts });
      printRulesFileState(result, 'set');
      return;
    }
    if (action === 'publish') {
      const result = await groupRulesFilePublish({ from, groupId, ...commonOpts });
      printRulesFileState(result, 'publish');
      return;
    }
    if (action && !action.startsWith('--')) {
      console.error(`❌ 未知 rules 动作: ${action}`);
      printRulesFileUsage();
      process.exit(1);
    }

    const wantsUpdate = args.includes('--mode') || args.includes('--question') || args.includes('--max-pending');
    if (!wantsUpdate) {
      const result = await groupRules({ from, groupId, ...commonOpts });
      outputResult(result, () => {
        const r = result as any;
        console.log(`Rules: ${r.group_id}`);
        console.log(prettyJson(r.rules));
      });
      return;
    }

    const modeRaw = args.includes('--mode') ? requireFlagValue('--mode', '--mode') : undefined;
    const mode = modeRaw ? modeRaw.toLowerCase() : undefined;
    if (mode && !['open', 'approval', 'invite_only', 'closed'].includes(mode)) {
      console.error('❌ --mode 必须是 open|approval|invite_only|closed');
      process.exit(1);
    }
    const question = args.includes('--question') ? requireFlagValue('--question', '--question') : undefined;
    const maxPending = parseNumberFlag('--max-pending', '--max-pending');
    const result = await groupUpdateRules({
      from,
      groupId,
      mode: mode as any,
      question,
      maxPending,
      ...commonOpts,
    });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 已更新规则 ${r.group_id}`);
      console.log(prettyJson(r.rules));
    });
    return;
  }

  // ---- 成员 ----

  if (sub === 'join') {
    const groupId = requireGroupId();
    const result = await groupJoin({
      from, groupId,
      message: getArgValue(args, '--message'),
      answer: getArgValue(args, '--answer'),
      ...commonOpts,
    });
    outputResult(result, () => {
      console.log(`✓ 已提交入群申请`);
    });
    return;
  }

  if (sub === 'leave') {
    const groupId = requireGroupId();
    const result = await groupLeave({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已退出 ${groupId}`);
    });
    return;
  }

  if (sub === 'invite') {
    const groupId = requireGroupId();
    const members = collectPositional(args, 3);
    if (members.length === 0) {
      console.error('用法: evolclaw group invite <from> <group-id> <member-aid> [<member-aid>...]');
      process.exit(1);
    }
    for (const m of members) {
      if (!isValidAid(m)) {
        console.error(`❌ 无效 AID: ${m}`);
        process.exit(1);
      }
    }
    const result = await groupInvite({ from, groupId, members, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 成功 ${r.added.length}，失败 ${r.failed.length}`);
      for (const a of r.added) console.log(`  + ${a}`);
      for (const f of r.failed) console.log(`  ✗ ${f.aid}: ${f.error}`);
    });
    return;
  }

  if (sub === 'kick') {
    const groupId = requireGroupId();
    const memberAid = args[3];
    if (!memberAid) {
      console.error('用法: evolclaw group kick <from> <group-id> <member-aid>');
      process.exit(1);
    }
    const result = await groupKick({ from, groupId, memberAid, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已踢出 ${memberAid}`);
    });
    return;
  }

  if (sub === 'members') {
    const groupId = requireGroupId();
    const pageStr = getArgValue(args, '--page');
    const sizeStr = getArgValue(args, '--size');
    const result = await groupMembers({
      from, groupId,
      page: pageStr !== undefined ? Number(pageStr) : undefined,
      size: sizeStr !== undefined ? Number(sizeStr) : undefined,
      ...commonOpts,
    });
    outputResult(result, () => {
      const r = result as any;
      console.log(`共 ${r.total} 名成员（第 ${r.page} 页）:`);
      for (const m of r.members) {
        console.log(`  [${m.role}] ${m.aid}`);
      }
    });
    return;
  }

  if (sub === 'online') {
    const groupId = requireGroupId();
    const result = await groupOnline({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`在线 ${r.online_count}/${r.total}:`);
      for (const m of r.members) {
        console.log(`  🟢 ${m.aid}`);
      }
    });
    return;
  }

  if (sub === 'role') {
    const groupId = requireGroupId();
    const values = collectPositional(args, 3);
    if (values.length !== 2) {
      console.error('用法: evolclaw group role <from> <group-id> <member-aid> <admin|member>');
      process.exit(1);
    }
    const [memberAid, roleRaw] = values;
    if (!isValidAid(memberAid)) {
      console.error(`❌ 无效 AID: ${memberAid}`);
      process.exit(1);
    }
    const role = roleRaw.toLowerCase();
    if (role !== 'admin' && role !== 'member') {
      console.error('❌ 角色必须是 admin 或 member');
      process.exit(1);
    }
    const result = await groupSetRole({ from, groupId, memberAid, role: role as 'admin' | 'member', ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已将 ${memberAid} 设为 ${role}`);
    });
    return;
  }

  if (sub === 'owner') {
    const groupId = requireGroupId();
    const values = collectPositional(args, 3);
    if (values.length !== 1) {
      console.error('用法: evolclaw group owner <from> <group-id> <new-owner-aid>');
      process.exit(1);
    }
    const [newOwner] = values;
    if (!isValidAid(newOwner)) {
      console.error(`❌ 无效 AID: ${newOwner}`);
      process.exit(1);
    }
    const result = await groupTransferOwner({ from, groupId, newOwner, ...commonOpts });
    outputResult(result, () => {
      const data = (result as any).data ?? {};
      if (data.status === 'pending_rekey') {
        console.log(`✓ 已发起群主转让，等待 ${newOwner} 完成 rekey`);
        if (data.complete_error) console.log(`  自动完成失败: ${data.complete_error}`);
        return;
      }
      console.log(`✓ 已将群主转让给 ${newOwner}${data.auto_completed ? '（已自动完成 rekey）' : ''}`);
    });
    return;
  }

  if (sub === 'ban') {
    const groupId = requireGroupId();
    const values = collectPositional(args, 3, new Set(['--duration']));
    if (values.length === 0) {
      const result = await groupBanlist({ from, groupId, ...commonOpts });
      outputResult(result, () => {
        const r = result as any;
        if (r.items.length === 0) {
          console.log('(没有封禁成员)');
          return;
        }
        console.log(`共 ${r.items.length} 条封禁:`);
        for (const item of r.items) {
          console.log(`  ${renderBanItem(item)}`);
        }
      });
      return;
    }
    if (values.length !== 1) {
      console.error('用法: evolclaw group ban <from> <group-id> [<member-aid>] [--duration <seconds>]');
      process.exit(1);
    }
    const [memberAid] = values;
    if (!isValidAid(memberAid)) {
      console.error(`❌ 无效 AID: ${memberAid}`);
      process.exit(1);
    }
    const durationSeconds = parseNumberFlag('--duration', '--duration');
    const result = await groupBan({ from, groupId, memberAid, durationSeconds, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已封禁 ${memberAid}${durationSeconds !== undefined ? ` (${durationSeconds}s)` : ''}`);
    });
    return;
  }

  if (sub === 'unban') {
    const groupId = requireGroupId();
    const values = collectPositional(args, 3);
    if (values.length !== 1) {
      console.error('用法: evolclaw group unban <from> <group-id> <member-aid>');
      process.exit(1);
    }
    const [memberAid] = values;
    if (!isValidAid(memberAid)) {
      console.error(`❌ 无效 AID: ${memberAid}`);
      process.exit(1);
    }
    const result = await groupUnban({ from, groupId, memberAid, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已解封 ${memberAid}`);
    });
    return;
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw group [send|pull|ack|create|list|info|update|dissolve|suspend|resume|rules|join|leave|invite|kick|members|online|role|owner|ban|unban]`);
  process.exit(1);
}

// ==================== Main ====================

/**
 * 收集位置参数（从 startIdx 开始）。
 *
 * flag 判定采用**精确匹配已知 flag 集合**，而非 `startsWith('--')`——
 * 这样"正文恰好以 -- 开头"（如消息文本 `--file 坏了`）不会被误当 flag 吞掉。
 * 仅当 token 精确等于某个已知 flag 时才按 flag 处理：
 *   - VALUE_FLAGS：消耗自身 + 下一个 arg（flag 的值）
 *   - BOOLEAN_FLAGS：仅消耗自身
 * 其余以 -- 开头但不在集合中的 token，一律视为正文。
 *
 * 另支持 POSIX `--` end-of-options 分隔符：遇到单独的 `--` 后，
 * 其后所有 token 无条件按正文处理（用于发送精确等于某 flag 的文本，如 `-- --encrypt`）。
 */
const VALUE_FLAGS = new Set([
  '--format', '--app', '--after-seq', '--limit', '--file', '--link',
  '--payload', '--title', '--description', '--text', '--transcript',
  '--as', '--content-type', '--mention', '--visibility', '--join-mode',
  '--group-id', '--name', '--message', '--answer', '--page', '--size',
  '--aun-path', '--thread', '--return',
]);
const BOOLEAN_FLAGS = new Set([
  '--encrypt', '--no-encrypt', '--mention-all',
]);
function collectPositional(args: string[], startIdx: number, extraValueFlags?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let endOfFlags = false;
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (endOfFlags) { out.push(a); continue; }
    if (a === '--') { endOfFlags = true; continue; }
    if (VALUE_FLAGS.has(a) || extraValueFlags?.has(a)) { i++; continue; }   // 精确匹配取值 flag：跳过其值
    if (BOOLEAN_FLAGS.has(a)) { continue; }       // 精确匹配开关 flag：仅跳过自身
    out.push(a);                                  // 其余（含以 -- 开头的未知 token）= 正文
  }
  return out;
}
