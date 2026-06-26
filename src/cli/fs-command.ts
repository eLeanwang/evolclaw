import fs from 'fs';
import { TextDecoder } from 'util';
import type { AIDStore, AUNClient } from '@agentunion/fastaun';
import { getArgValue, isHelpFlag, wantsHelp } from './help.js';
import { agentmdGet, getAidStore, isValidAid, loadClient, SLOT } from '../aun/aid/index.js';

type FsBackend = 'personal' | 'group';

interface RemotePath {
  aid: string;
  path: string;
  raw: string;
}

interface CommonOptions {
  formatJson: boolean;
  actorAid?: string;
  aunPath?: string;
  slotId?: string;
  token?: string;
  overwrite: boolean;
  publicRead: boolean;
  contentType?: string;
  maxCatBytes: number;
  headBytes: number;
}

interface RouteInfo {
  backend: FsBackend;
  aidType?: string;
  source: 'agentmd' | 'default';
  warning?: string;
}

class FsCliError extends Error {
  code: string;
  suggestion?: string;
  details?: unknown;

  constructor(code: string, message: string, suggestion?: string, details?: unknown) {
    super(message);
    this.name = 'FsCliError';
    this.code = code;
    this.suggestion = suggestion;
    this.details = details;
  }
}

const HELP = `用法: evolclaw fs <command> [args...] [options]

Commands:
  ls <AID>:<path>                 列目录
  stat [-L] <AID>:<path>          查看节点元数据（默认不跟随软链；-L 跟随）
  lstat <AID>:<path>              查看节点本身（不跟随末级软链）
  cat <AID>:<path>                输出文本文件内容；二进制/大文件返回头部摘要
  cp <local> <AID>:<path>         上传本地文件
  cp <AID>:<path> <local>         下载远程文件
  cp <AID>:<path> <AID>:<path>    远程复制（同后端）
  mv <AID>:<path> <AID>:<path>    移动/改名（同后端）
  rm [-r] <AID>:<path>            删除文件或目录
  mkdir [-p] <AID>:<path>         创建目录
  ln -s <target> <AID>:<path>     创建软链（personal storage）
  chmod [mode] <AID>:<path>       切换公开/私有（personal storage）
  setfacl <AID>:<path> -m|-x ...   设置/移除 ACL（personal storage）
  getfacl <AID>:<path>            查看 ACL（personal storage）
  token issue|revoke|ls <path>    管理访问 token（personal storage）
  find <AID>:<path> [filters]     查找节点
  df <AID>:                       查看容量/配额
  mount <target> --volume <id>    挂载实体卷
  mount <target> --source <src>   挂载远程子树
  approve <AID>:<path>            批准待审挂载（personal storage）
  reject <AID>:<path>             拒绝待审挂载（personal storage）
  umount <AID>:<path>             卸载挂载点

Options:
  --as <aid>                      操作者 AID；也可由 EVOLCLAW_SELF_AID 注入
  --format json                   输出 JSON
  --overwrite, --force            覆盖目标（用于 cp/mv/ln）或强制删除（用于 rm）
  -r, --recursive                 递归（用于 rm/cp）
  -p, --parents                   自动创建父目录（用于 mkdir/group 上传）
  -L, --follow                    stat 跟随末级软链
  --token <token>                 读取时携带访问 token（personal storage）
  --content-type <mime>           上传时指定内容类型
  --public                        上传后公开可读（personal storage）
  --visibility <public|private>   chmod 可见性
  --allow-roles <roles>           chmod 角色约束，逗号分隔
  -m aid:<aid>:<perms>            setfacl 新增/更新 ACL
  -x aid:<aid>                    setfacl 移除 ACL
  --source <AID>:<path>           mount 虚拟卷来源
  --volume <id>                   mount 实体卷 ID
  --require-approval              mount 需要来源 owner 审批
  --expires <time>                mount/token/ACL 过期时间，Unix 秒或 ISO 日期
  --max-uses <n>                  ACL 最大使用次数
  --max-reads <n>                 token 最大读取次数
  --readonly, --readwrite         mount 只读/读写
  --name <glob>                   find 名称过滤
  --type <f|d|l>                  find 类型过滤
  --size <expr>                   find 大小过滤，如 +1M
  --mtime <expr>                  find 修改时间过滤
  --head-bytes <n>                cat 二进制头部字节数，默认 256
  --max-bytes <n>                 cat 最大直接输出字节数，默认 1048576
  --aun-path <path>               指定 AUN keystore 根
  --app <name>                    指定 AUN app slot

示例:
  evolclaw fs ls alice.agentid.pub:/private/
  evolclaw fs cp ./report.md alice.agentid.pub:/private/report.md --as alice.agentid.pub
  evolclaw fs cp alice.agentid.pub:/private/report.md ./report.md --as alice.agentid.pub
  evolclaw fs cp alice.agentid.pub:/private/a.md bob.agentid.pub:/inbox/a.md --as alice.agentid.pub
  evolclaw fs cat alice.agentid.pub:/private/report.md --as alice.agentid.pub
  evolclaw fs ln -s alice.agentid.pub:/private/report.md alice.agentid.pub:/public/report.md --as alice.agentid.pub
  evolclaw fs chmod +r alice.agentid.pub:/public/report.md --as alice.agentid.pub
  evolclaw fs setfacl alice.agentid.pub:/private/report.md -m aid:bob.agentid.pub:r --as alice.agentid.pub
  evolclaw fs token issue alice.agentid.pub:/public/report.md --expires 2026-12-31 --as alice.agentid.pub
  evolclaw fs find alice.agentid.pub:/private/ --name "*.md" --as alice.agentid.pub
  evolclaw fs df alice.agentid.pub: --as alice.agentid.pub`;

const VALUE_FLAGS = new Set([
  '--as',
  '--format',
  '--aun-path',
  '--app',
  '--token',
  '--content-type',
  '--max-bytes',
  '--head-bytes',
  '--expected-version',
  '--expires',
  '--name',
  '--pattern',
  '--type',
  '--node-type',
  '--size',
  '--page',
  '--page-size',
  '--mtime',
  '--volume',
  '--source',
  '--source-bucket',
  '--expires-at',
  '--max-uses',
  '--max-reads',
  '--visibility',
  '--allow-roles',
  '--mount-id',
  '--request-id',
]);

const SHORT_VALUE_FLAGS = new Set(['-m', '-x']);

export async function cmdFs(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = getArgValue(args, '--format') === 'json';
  let opts: CommonOptions;
  try {
    opts = parseCommonOptions(args);
  } catch (e: any) {
    outputError(e, formatJson);
    process.exit(1);
  }

  if (!sub || isHelpFlag(sub) || wantsHelp(args)) {
    console.log(HELP);
    return;
  }

  try {
    switch (sub) {
      case 'ls':
        await fsLs(args.slice(1), opts);
        return;
      case 'stat':
        await fsStat(args.slice(1), opts, hasShortFlag(args.slice(1), 'L') || args.includes('--follow'));
        return;
      case 'lstat':
        await fsStat(args.slice(1), opts, false);
        return;
      case 'cat':
        await fsCat(args.slice(1), opts);
        return;
      case 'cp':
        await fsCp(args.slice(1), opts);
        return;
      case 'mv':
        await fsMv(args.slice(1), opts);
        return;
      case 'rm':
        await fsRm(args.slice(1), opts);
        return;
      case 'mkdir':
        await fsMkdir(args.slice(1), opts);
        return;
      case 'ln':
        await fsLn(args.slice(1), opts);
        return;
      case 'chmod':
        await fsChmod(args.slice(1), opts);
        return;
      case 'setfacl':
        await fsSetfacl(args.slice(1), opts);
        return;
      case 'getfacl':
        await fsGetfacl(args.slice(1), opts);
        return;
      case 'token':
        await fsToken(args.slice(1), opts);
        return;
      case 'find':
        await fsFind(args.slice(1), opts);
        return;
      case 'df':
        await fsDf(args.slice(1), opts);
        return;
      case 'mount':
        await fsMount(args.slice(1), opts);
        return;
      case 'approve':
        await fsApproveReject(args.slice(1), opts, 'approve');
        return;
      case 'reject':
        await fsApproveReject(args.slice(1), opts, 'reject');
        return;
      case 'umount':
      case 'unmount':
        await fsUmount(args.slice(1), opts);
        return;
      default:
        throw new FsCliError('UNKNOWN_COMMAND', `未知子命令: ${sub}`, '运行 evolclaw fs --help 查看可用命令。');
    }
  } catch (e: any) {
    outputError(e, opts.formatJson);
    process.exit(1);
  }
}

function parseCommonOptions(args: string[]): CommonOptions {
  const maxCatBytesRaw = getArgValue(args, '--max-bytes');
  const maxCatBytes = maxCatBytesRaw === undefined ? 1024 * 1024 : Number(maxCatBytesRaw);
  if (!Number.isFinite(maxCatBytes) || maxCatBytes <= 0) {
    throw new FsCliError('INVALID_ARGUMENT', `--max-bytes 必须是正数: ${maxCatBytesRaw}`);
  }
  const headBytesRaw = getArgValue(args, '--head-bytes');
  const headBytes = headBytesRaw === undefined ? 256 : Number(headBytesRaw);
  if (!Number.isInteger(headBytes) || headBytes < 0) {
    throw new FsCliError('INVALID_ARGUMENT', `--head-bytes 必须是非负整数: ${headBytesRaw}`);
  }

  return {
    formatJson: getArgValue(args, '--format') === 'json',
    actorAid: getArgValue(args, '--as') ?? process.env.EVOLCLAW_SELF_AID,
    aunPath: getArgValue(args, '--aun-path') ?? process.env.AUN_HOME,
    slotId: getArgValue(args, '--app'),
    token: getArgValue(args, '--token'),
    overwrite: args.includes('--overwrite') || args.includes('--force') || hasShortFlag(args, 'f'),
    publicRead: args.includes('--public'),
    contentType: getArgValue(args, '--content-type'),
    maxCatBytes,
    headBytes,
  };
}

function requireActor(opts: CommonOptions): string {
  const aid = opts.actorAid?.trim();
  if (!aid) {
    throw new FsCliError(
      'MISSING_ACTOR',
      '缺少操作者身份',
      '请添加 --as <aid>，或在 agent 会话中注入 EVOLCLAW_SELF_AID。'
    );
  }
  if (!isValidAid(aid)) {
    throw new FsCliError('INVALID_AID', `无效操作者 AID: ${aid}`);
  }
  return aid;
}

async function withClient<T>(
  opts: CommonOptions,
  fn: (ctx: { client: AUNClient; store: AIDStore; actorAid: string }) => Promise<T>,
): Promise<T> {
  const actorAid = requireActor(opts);
  const store = await getAidStore({ slotId: opts.slotId ?? SLOT.cli, aunPath: opts.aunPath });
  let client: AUNClient | undefined;
  try {
    client = await loadClient(store, actorAid);
    await client.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false });
    return await fn({ client, store, actorAid });
  } catch (e: any) {
    if (e instanceof FsCliError) throw e;
    throw mapBackendError(e);
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    try { store.close(); } catch { /* ignore */ }
  }
}

async function fsLs(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'ls' });
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      const result = await client.group.fs.ls(remoteRef(target));
      outputSuccess(opts, {
        command: 'ls',
        backend: route.backend,
        route,
        path: remoteRef(target),
        items: extractItems(result),
        raw: result,
      }, () => printList(target, result));
    } else {
      const items = await client.storage.list(target.path || '/', { owner: target.aid, token: opts.token });
      outputSuccess(opts, {
        command: 'ls',
        backend: route.backend,
        route,
        path: remoteRef(target),
        items,
      }, () => printList(target, items));
    }
  });
}

async function fsStat(args: string[], opts: CommonOptions, follow: boolean): Promise<void> {
  const command = follow ? 'stat' : 'lstat';
  const target = parseRemoteRequired(firstPositional(args), { command });
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    const node = route.backend === 'group'
      ? follow
        ? await client.group.fs.stat(remoteRef(target))
        : await client.group.fs.lstat(remoteRef(target))
      : follow
        ? await client.storage.stat(target.path, { owner: target.aid, token: opts.token })
        : await client.storage.lstat(target.path, { owner: target.aid, token: opts.token });
    outputSuccess(opts, {
      command,
      backend: route.backend,
      route,
      path: remoteRef(target),
      node,
    }, () => printNode(target.aid, node));
  });
}

async function fsCat(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'cat' });
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    let statInfo: any;
    let bytes: Uint8Array;
    let binaryHeadOnly = false;

    if (route.backend === 'group') {
      statInfo = await client.group.fs.stat(remoteRef(target));
      const size = numberFrom(statInfo, ['size', 'size_bytes', 'bytes']);
      const downloaded = await client.group.fs.cp(remoteRef(target), { kind: 'blob' } as any, { verifyHash: true });
      bytes = bytesFromDownload(downloaded);
      statInfo = { ...statInfo, size: bytes.byteLength };
      if (size !== undefined && size > opts.maxCatBytes) {
        binaryHeadOnly = true;
      }
    } else {
      statInfo = await client.storage.stat(target.path, { owner: target.aid, token: opts.token });
      const size = numberFrom(statInfo, ['size', 'sizeBytes', 'size_bytes']);
      if (size !== undefined && size > opts.maxCatBytes) {
        bytes = await client.storage.readBytes(target.path, { owner: target.aid, token: opts.token, offset: 0, limit: opts.headBytes });
        binaryHeadOnly = true;
      } else {
        bytes = await client.storage.readBytes(target.path, { owner: target.aid, token: opts.token });
      }
    }

    const binary = looksBinary(bytes, contentTypeFrom(statInfo));
    if (binary || binaryHeadOnly) {
      const size = numberFrom(statInfo, ['size', 'sizeBytes', 'size_bytes']) ?? bytes.byteLength;
      const payload = {
        command: 'cat',
        backend: route.backend,
        route,
        path: remoteRef(target),
        size,
        contentType: contentTypeFrom(statInfo),
        binary: true,
        head: {
          encoding: 'base64',
          bytes: Math.min(opts.headBytes, bytes.byteLength),
          data: Buffer.from(bytes.subarray(0, Math.min(opts.headBytes, bytes.byteLength))).toString('base64'),
        },
      };
      outputSuccess(opts, payload, () => {
        console.log(JSON.stringify({
          path: remoteRef(target),
          size,
          content_type: contentTypeFrom(statInfo),
          binary: true,
          head: payload.head,
        }, null, 2));
      });
      return;
    }

    const text = decodeUtf8(bytes, remoteRef(target));
    outputSuccess(opts, {
      command: 'cat',
      backend: route.backend,
      route,
      path: remoteRef(target),
      size: bytes.byteLength,
      contentType: contentTypeFrom(statInfo),
      text,
    }, () => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`));
  });
}

async function fsFind(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'find' });
  const name = getArgValue(args, '--name') ?? getArgValue(args, '--pattern');
  const nodeType = getArgValue(args, '--type') ?? getArgValue(args, '--node-type');
  const size = getArgValue(args, '--size');
  const mtime = getArgValue(args, '--mtime');
  const page = parseOptionalPositiveInt(getArgValue(args, '--page'), '--page');
  const pageSize = parseOptionalPositiveInt(getArgValue(args, '--page-size'), '--page-size');

  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      const result = await client.group.fs.find(remoteRef(target), {
        name,
        pattern: name,
        type: nodeType,
        size,
        mtime,
        page,
        page_size: pageSize,
      });
      outputSuccess(opts, {
        command: 'find',
        backend: route.backend,
        route,
        path: remoteRef(target),
        items: extractItems(result),
        raw: result,
      }, () => printList(target, result));
    } else {
      const items = await client.storage.find(target.path, {
        owner: target.aid,
        token: opts.token,
        name,
        nodeType,
        size,
        mtime,
        page,
        pageSize,
      });
      outputSuccess(opts, {
        command: 'find',
        backend: route.backend,
        route,
        path: remoteRef(target),
        items,
      }, () => printList(target, items));
    }
  });
}

async function fsCp(args: string[], opts: CommonOptions): Promise<void> {
  const positional = collectPositionals(args);
  const srcArg = positional[0];
  const dstArg = positional[1];
  if (!srcArg || !dstArg) {
    throw new FsCliError('INVALID_ARGUMENT', '用法: evolclaw fs cp <src> <dst>', '至少一端必须是 <AID>:<path>。');
  }

  const srcRemote = parseRemoteMaybe(srcArg);
  const dstRemote = parseRemoteMaybe(dstArg);

  if (!srcRemote && !dstRemote) {
    throw new FsCliError('INVALID_ARGUMENT', 'cp 需要至少一端是远程路径', '远程路径格式为 <AID>:<absolute-path>。');
  }

  await withClient(opts, async ({ client, store }) => {
    if (srcRemote && dstRemote) {
      const srcRoute = await resolveRoute(srcRemote.aid, store);
      const dstRoute = await resolveRoute(dstRemote.aid, store);
      if (srcRoute.backend !== dstRoute.backend) {
        throw new FsCliError('UNSUPPORTED', '当前版本不支持 personal/group 混合远程复制', '请先下载到本地再上传。');
      }
      if (srcRoute.backend === 'group') {
        const result = await client.group.fs.cp(remoteRef(srcRemote), remoteRef(dstRemote), {
          force: opts.overwrite,
          overwrite: opts.overwrite,
          recursive: hasShortFlag(args, 'r') || args.includes('--recursive'),
          followSymlinks: args.includes('--follow-symlinks'),
        });
        outputSuccess(opts, {
          command: 'cp',
          direction: 'remote-to-remote',
          backend: srcRoute.backend,
          route: srcRoute,
          src: remoteRef(srcRemote),
          dst: remoteRef(dstRemote),
          result,
        }, () => console.log(`✓ 已复制: ${remoteRef(srcRemote)} -> ${remoteRef(dstRemote)}`));
        return;
      }
      const node = await client.storage.copy(srcRemote.path, dstRemote.path, {
        owner: srcRemote.aid,
        dstOwner: dstRemote.aid,
        overwrite: opts.overwrite,
        recursive: hasShortFlag(args, 'r') || args.includes('--recursive'),
        followSymlinks: args.includes('--follow-symlinks'),
      });
      outputSuccess(opts, {
        command: 'cp',
        direction: 'remote-to-remote',
        backend: srcRoute.backend,
        route: srcRoute,
        src: remoteRef(srcRemote),
        dst: remoteRef(dstRemote),
        node,
      }, () => console.log(`✓ 已复制: ${remoteRef(srcRemote)} -> ${remoteRef(dstRemote)}`));
      return;
    }

    if (dstRemote) {
      const localPath = srcArg;
      assertLocalFile(localPath);
      const route = await resolveRoute(dstRemote.aid, store);
      if (route.backend === 'group') {
        const result = await client.group.fs.cp(localPath, remoteRef(dstRemote), {
          force: opts.overwrite,
          overwrite: opts.overwrite,
          contentType: opts.contentType,
          parents: true,
        });
        outputSuccess(opts, {
          command: 'cp',
          direction: 'upload',
          backend: route.backend,
          route,
          localPath,
          path: remoteRef(dstRemote),
          result,
        }, () => console.log(`✓ 已上传: ${localPath} -> ${remoteRef(dstRemote)}`));
      } else {
        const node = await client.storage.uploadFile(localPath, dstRemote.path, {
          owner: dstRemote.aid,
          overwrite: opts.overwrite,
          contentType: opts.contentType,
          public: opts.publicRead,
        });
        outputSuccess(opts, {
          command: 'cp',
          direction: 'upload',
          backend: route.backend,
          route,
          localPath,
          path: remoteRef(dstRemote),
          node,
        }, () => console.log(`✓ 已上传: ${localPath} -> ${remoteRef(dstRemote)}`));
      }
      return;
    }

    if (srcRemote) {
      const localPath = dstArg;
      const route = await resolveRoute(srcRemote.aid, store);
      if (route.backend === 'group') {
        const result = await client.group.fs.cp(remoteRef(srcRemote), localPath, {
          force: opts.overwrite,
          overwrite: opts.overwrite,
          verifyHash: true,
        });
        outputSuccess(opts, {
          command: 'cp',
          direction: 'download',
          backend: route.backend,
          route,
          path: remoteRef(srcRemote),
          localPath: (result as any)?.localPath ?? localPath,
          result,
        }, () => console.log(`✓ 已下载: ${remoteRef(srcRemote)} -> ${(result as any)?.localPath ?? localPath}`));
      } else {
        const result = await client.storage.downloadFile(srcRemote.path, localPath, {
          owner: srcRemote.aid,
          token: opts.token,
          overwrite: opts.overwrite,
          verifyHash: true,
        });
        outputSuccess(opts, {
          command: 'cp',
          direction: 'download',
          backend: route.backend,
          route,
          path: remoteRef(srcRemote),
          localPath: result.localPath ?? localPath,
          size: result.size,
          verified: result.verified,
        }, () => console.log(`✓ 已下载: ${remoteRef(srcRemote)} -> ${result.localPath ?? localPath} (${result.size} bytes)`));
      }
    }
  });
}

async function fsMv(args: string[], opts: CommonOptions): Promise<void> {
  const positional = collectPositionals(args);
  const src = parseRemoteRequired(positional[0], { command: 'mv' });
  const dst = parseRemoteRequired(positional[1], { command: 'mv' });
  const expectedVersion = parseOptionalPositiveInt(getArgValue(args, '--expected-version'), '--expected-version');

  await withClient(opts, async ({ client, store }) => {
    const srcRoute = await resolveRoute(src.aid, store);
    const dstRoute = await resolveRoute(dst.aid, store);
    if (srcRoute.backend !== dstRoute.backend) {
      throw new FsCliError('UNSUPPORTED', '当前版本不支持 personal/group 混合远程移动', '请先 cp 到目标，再确认后 rm 源路径。');
    }

    if (srcRoute.backend === 'group') {
      const result = await client.group.fs.mv(remoteRef(src), remoteRef(dst), {
        force: opts.overwrite,
        overwrite: opts.overwrite,
      });
      outputSuccess(opts, {
        command: 'mv',
        backend: srcRoute.backend,
        route: srcRoute,
        src: remoteRef(src),
        dst: remoteRef(dst),
        result,
      }, () => console.log(`✓ 已移动: ${remoteRef(src)} -> ${remoteRef(dst)}`));
      return;
    }

    if (src.aid !== dst.aid) {
      throw new FsCliError('UNSUPPORTED', 'personal storage 不支持跨 owner 原子移动', `请使用 evolclaw fs cp ${remoteRef(src)} ${remoteRef(dst)}，确认后再 rm 源路径。`);
    }

    const node = await client.storage.rename(src.path, dst.path, {
      owner: src.aid,
      overwrite: opts.overwrite,
      expectedVersion,
    });
    outputSuccess(opts, {
      command: 'mv',
      backend: srcRoute.backend,
      route: srcRoute,
      src: remoteRef(src),
      dst: remoteRef(dst),
      node,
    }, () => console.log(`✓ 已移动: ${remoteRef(src)} -> ${remoteRef(dst)}`));
  });
}

async function fsRm(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'rm' });
  const recursive = hasShortFlag(args, 'r') || args.includes('--recursive');
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      const result = await client.group.fs.rm(remoteRef(target), { recursive, force: opts.overwrite });
      outputSuccess(opts, {
        command: 'rm',
        backend: route.backend,
        route,
        path: remoteRef(target),
        result,
        recursive,
      }, () => console.log(`✓ 已删除: ${remoteRef(target)}`));
    } else {
      const result = await client.storage.remove(target.path, { owner: target.aid, recursive });
      outputSuccess(opts, {
        command: 'rm',
        backend: route.backend,
        route,
        path: remoteRef(target),
        result,
        recursive,
      }, () => console.log(`✓ 已删除: ${remoteRef(target)}`));
    }
  });
}

async function fsMkdir(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'mkdir' });
  const parents = hasShortFlag(args, 'p') || args.includes('--parents');

  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      const result = await client.group.fs.mkdir(remoteRef(target), { parents });
      outputSuccess(opts, {
        command: 'mkdir',
        backend: route.backend,
        route,
        path: remoteRef(target),
        result,
      }, () => console.log(`✓ 已创建目录: ${remoteRef(target)}`));
      return;
    }

    const node = await client.storage.mkdir(target.path, { owner: target.aid, parents });
    outputSuccess(opts, {
      command: 'mkdir',
      backend: route.backend,
      route,
      path: remoteRef(target),
      node,
    }, () => console.log(`✓ 已创建目录: ${remoteRef(target)}`));
  });
}

async function fsLn(args: string[], opts: CommonOptions): Promise<void> {
  if (!hasShortFlag(args, 's') && !args.includes('--symbolic')) {
    throw new FsCliError('UNSUPPORTED', 'ec fs ln 只支持软链接', '请使用 evolclaw fs ln -s <target> <link-path>。');
  }

  const positional = collectPositionals(args);
  const target = positional[0];
  if (!target) {
    throw new FsCliError('INVALID_ARGUMENT', '用法: evolclaw fs ln -s <target> <link-path>');
  }
  const link = parseRemoteRequired(positional[1], { command: 'ln' });
  const linkTarget = linkTargetValue(target, link.aid);

  await withClient(opts, async ({ client, store }) => {
    const linkRoute = await resolveRoute(link.aid, store);
    if (linkRoute.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', 'group fs 当前 SDK facade 没有软链创建接口', '请在 personal storage 中创建软链，或等待 group fs 暴露 symlink 能力。');
    }

    const node = opts.overwrite
      ? await client.storage.repoint(link.path, linkTarget, {
          owner: link.aid,
          expectedVersion: parseOptionalPositiveInt(getArgValue(args, '--expected-version'), '--expected-version'),
        })
      : await client.storage.symlink(linkTarget, link.path, {
          owner: link.aid,
          overwrite: false,
        });
    outputSuccess(opts, {
      command: 'ln',
      backend: linkRoute.backend,
      route: linkRoute,
      target,
      link: remoteRef(link),
      node,
    }, () => console.log(`✓ 已创建软链: ${remoteRef(link)} -> ${target}`));
  });
}

async function fsChmod(args: string[], opts: CommonOptions): Promise<void> {
  const positional = collectPositionals(args);
  const explicitVisibility = getArgValue(args, '--visibility');
  const allowRoles = parseCsv(getArgValue(args, '--allow-roles'));
  const mode = explicitVisibility ? undefined : positional.length >= 2 ? positional[0] : undefined;
  const targetArg = explicitVisibility || allowRoles.length > 0 ? positional[positionalsTargetIndex(positional)] : positional[1];
  const target = parseRemoteRequired(targetArg, { command: 'chmod' });
  const requestedVisibility = parseVisibility(explicitVisibility ?? mode);

  if (!requestedVisibility) {
    throw new FsCliError(
      'INVALID_ARGUMENT',
      'chmod 缺少可见性或角色约束',
      '请使用 +r/o-r，或 --visibility public|private，或 --allow-roles <roles>。'
    );
  }

  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', 'group fs 当前 SDK facade 没有 chmod/setVisibility 接口', '请等待 group fs 暴露权限修改能力，或使用 personal storage 的 chmod。');
    }

    const node = await client.storage.setVisibility(target.path, {
      owner: target.aid,
      visibility: requestedVisibility,
      allowRoles: allowRoles.length > 0 ? allowRoles : undefined,
    });
    outputSuccess(opts, {
      command: 'chmod',
      backend: route.backend,
      route,
      path: remoteRef(target),
      visibility: requestedVisibility,
      allowRoles,
      node,
    }, () => console.log(`✓ 已更新权限: ${remoteRef(target)} (${requestedVisibility})`));
  });
}

async function fsSetfacl(args: string[], opts: CommonOptions): Promise<void> {
  const positional = collectPositionals(args);
  const target = parseRemoteRequired(positional[0], { command: 'setfacl' });
  const modify = getArgValue(args, '-m');
  const remove = getArgValue(args, '-x');
  const expiresAt = parseOptionalTimestamp(getArgValue(args, '--expires'), '--expires');
  const maxUses = parseOptionalPositiveInt(getArgValue(args, '--max-uses'), '--max-uses');

  if (!!modify === !!remove) {
    throw new FsCliError('INVALID_ARGUMENT', 'setfacl 必须且只能指定 -m 或 -x', '用法: ec fs setfacl <AID>:<path> -m aid:bob.aid.pub:r');
  }

  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', 'group fs 当前 SDK facade 没有 setfacl 接口', '请在 personal storage 中使用 setfacl。');
    }

    if (modify) {
      const [grantee, perms] = parseAclSpec(modify, true);
      const result = await client.storage.setAcl(target.path, {
        owner: target.aid,
        granteeAid: grantee,
        perms,
        expiresAt,
        maxUses,
      });
      outputSuccess(opts, { command: 'setfacl', backend: route.backend, route, path: remoteRef(target), result }, () => console.log(`✓ 已设置 ACL: ${remoteRef(target)}`));
      return;
    }

    const [grantee] = parseAclSpec(remove || '', false);
    const result = await client.storage.removeAcl(target.path, {
      owner: target.aid,
      granteeAid: grantee,
    });
    outputSuccess(opts, { command: 'setfacl', backend: route.backend, route, path: remoteRef(target), result }, () => console.log(`✓ 已移除 ACL: ${remoteRef(target)}`));
  });
}

async function fsGetfacl(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'getfacl' });
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', 'group fs 当前 SDK facade 没有 getfacl/listAcl 接口', '请在 personal storage 中使用 getfacl。');
    }
    const result = await client.storage.listAcl(target.path, { owner: target.aid });
    outputSuccess(opts, { command: 'getfacl', backend: route.backend, route, path: remoteRef(target), result }, () => console.log(JSON.stringify(result, null, 2)));
  });
}

async function fsToken(args: string[], opts: CommonOptions): Promise<void> {
  const sub = args[0];
  if (!sub || isHelpFlag(sub) || wantsHelp(args)) {
    console.log(`用法: evolclaw fs token <issue|revoke|ls> <AID>:<path> [options]`);
    return;
  }
  switch (sub) {
    case 'issue':
      await fsTokenIssue(args.slice(1), opts);
      return;
    case 'revoke':
      await fsTokenRevoke(args.slice(1), opts);
      return;
    case 'ls':
      await fsTokenLs(args.slice(1), opts);
      return;
    default:
      throw new FsCliError('UNKNOWN_COMMAND', `未知 token 子命令: ${sub}`);
  }
}

async function fsTokenIssue(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'token issue' });
  const expiresAt = parseOptionalTimestamp(getArgValue(args, '--expires'), '--expires');
  const maxReads = parseOptionalPositiveInt(getArgValue(args, '--max-reads'), '--max-reads');
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', 'group fs 当前 SDK facade 没有 token 接口', '请在 personal storage 中签发 token。');
    }
    const result = await client.storage.issueToken(target.path, {
      owner: target.aid,
      expiresAt,
      maxReads,
    });
    outputSuccess(opts, { command: 'token issue', backend: route.backend, route, path: remoteRef(target), result }, () => {
      const token = String((result as any)?.token ?? (result as any)?.accessToken ?? '');
      console.log('✓ 已签发访问令牌');
      if (token) console.log(`  令牌: ${token}`);
    });
  });
}

async function fsTokenRevoke(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'token revoke' });
  const token = getArgValue(args, '--token');
  if (!token) {
    throw new FsCliError('INVALID_ARGUMENT', 'token revoke 需要 --token <token>');
  }
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', 'group fs 当前 SDK facade 没有 token 接口', '请在 personal storage 中吊销 token。');
    }
    const result = await client.storage.revokeToken(target.path, { owner: target.aid, token });
    outputSuccess(opts, { command: 'token revoke', backend: route.backend, route, path: remoteRef(target), result }, () => console.log(`✓ 已吊销 token: ${remoteRef(target)}`));
  });
}

async function fsTokenLs(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'token ls' });
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', 'group fs 当前 SDK facade 没有 token 接口', '请在 personal storage 中使用 token ls。');
    }
    const result = await client.storage.listTokens(target.path, { owner: target.aid });
    outputSuccess(opts, { command: 'token ls', backend: route.backend, route, path: remoteRef(target), result }, () => console.log(JSON.stringify(result, null, 2)));
  });
}

async function fsApproveReject(args: string[], opts: CommonOptions, action: 'approve' | 'reject'): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: action });
  const requestId = getArgValue(args, '--request-id');
  const mountId = getArgValue(args, '--mount-id');
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      throw new FsCliError('UNSUPPORTED', `group fs 当前 SDK facade 没有 ${action} 接口`, `请在 personal storage 中使用 ${action}。`);
    }
    const callOpts = { owner: target.aid, requestId, mountId };
    const result = action === 'approve'
      ? await client.storage.approveMount(target.path, callOpts)
      : await client.storage.rejectMount(target.path, callOpts);
    outputSuccess(opts, { command: action, backend: route.backend, route, path: remoteRef(target), result }, () => console.log(`✓ 已${action === 'approve' ? '批准' : '拒绝'}: ${remoteRef(target)}`));
  });
}

async function fsDf(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'df', allowEmptyPath: true });
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      const result = await client.group.fs.df(`${target.aid}:`);
      outputSuccess(opts, {
        command: 'df',
        backend: route.backend,
        route,
        path: `${target.aid}:`,
        usage: result,
      }, () => printUsage(target.aid, result));
    } else {
      const usage = await client.storage.df({ owner: target.aid });
      outputSuccess(opts, {
        command: 'df',
        backend: route.backend,
        route,
        path: `${target.aid}:`,
        usage,
      }, () => printUsage(target.aid, usage));
    }
  });
}

async function fsMount(args: string[], opts: CommonOptions): Promise<void> {
  const positional = collectPositionals(args);
  const volumeId = getArgValue(args, '--volume');
  const sourceValue = getArgValue(args, '--source');
  let mountTargetArg = positional[0];
  let sourceArg = sourceValue;

  if (!volumeId && !sourceArg && positional.length >= 2) {
    sourceArg = positional[0];
    mountTargetArg = positional[1];
  }

  if ((volumeId && sourceArg) || (!volumeId && !sourceArg)) {
    throw new FsCliError(
      'INVALID_ARGUMENT',
      'mount 必须且只能指定 --volume 或 --source',
      '用法: evolclaw fs mount <target> --volume <id>，或 evolclaw fs mount <target> --source <AID>:<path>。'
    );
  }

  const target = parseRemoteRequired(mountTargetArg, { command: 'mount' });
  const source = sourceArg ? parseRemoteRequired(sourceArg, { command: 'mount' }) : undefined;
  const expiresRaw = getArgValue(args, '--expires') ?? getArgValue(args, '--expires-at');
  const expiresAt = parseOptionalTimestamp(expiresRaw, expiresRaw === getArgValue(args, '--expires') ? '--expires' : '--expires-at');
  const readonly = parseReadonly(args) ?? true;
  const requireApproval = args.includes('--request-approval') || args.includes('--require-approval') || args.includes('--require_approval');

  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      const result = await client.group.fs.mount(remoteRef(target), {
        volume_id: volumeId,
        volumeId,
        source_aid: source?.aid,
        source_path: source?.path,
        source: source ? remoteRef(source) : undefined,
        source_bucket: getArgValue(args, '--source-bucket'),
        readonly,
        require_approval: requireApproval || undefined,
        requireApproval: requireApproval || undefined,
        expires_at: expiresAt,
        expiresAt,
      });
      outputSuccess(opts, {
        command: 'mount',
        backend: route.backend,
        route,
        target: remoteRef(target),
        source: source ? remoteRef(source) : undefined,
        volumeId,
        result,
      }, () => console.log(`✓ 已挂载: ${remoteRef(target)}`));
      return;
    }

    const common = {
      owner: target.aid,
      readonly,
      requireApproval,
      expiresAt,
      sourceBucket: getArgValue(args, '--source-bucket'),
    };
    const node = volumeId
      ? await client.storage.mountVolume(volumeId, remoteRef(target), common)
      : await client.storage.mount(remoteRef(source!), remoteRef(target), {
          ...common,
          sourceOwner: source!.aid,
        });
    outputSuccess(opts, {
      command: 'mount',
      backend: route.backend,
      route,
      target: remoteRef(target),
      source: source ? remoteRef(source) : undefined,
      volumeId,
      node,
    }, () => console.log(`✓ 已挂载: ${remoteRef(target)}`));
  });
}

async function fsUmount(args: string[], opts: CommonOptions): Promise<void> {
  const target = parseRemoteRequired(firstPositional(args), { command: 'umount' });
  await withClient(opts, async ({ client, store }) => {
    const route = await resolveRoute(target.aid, store);
    if (route.backend === 'group') {
      const result = await client.group.fs.umount(remoteRef(target));
      outputSuccess(opts, {
        command: 'umount',
        backend: route.backend,
        route,
        path: remoteRef(target),
        result,
      }, () => console.log(`✓ 已卸载: ${remoteRef(target)}（数据未删除）`));
      return;
    }

    const result = await client.storage.unmount(remoteRef(target), { owner: target.aid });
    outputSuccess(opts, {
      command: 'umount',
      backend: route.backend,
      route,
      path: remoteRef(target),
      result,
    }, () => console.log(`✓ 已卸载: ${remoteRef(target)}（数据未删除）`));
  });
}

async function resolveRoute(aid: string, store: AIDStore): Promise<RouteInfo> {
  try {
    const content = await agentmdGet(aid, { store });
    const aidType = parseAgentMdType(String(content));
    return {
      backend: aidType?.toLowerCase() === 'group' ? 'group' : 'personal',
      aidType,
      source: 'agentmd',
    };
  } catch (e: any) {
    return {
      backend: 'personal',
      source: 'default',
      warning: `无法读取 ${aid} 的 agent.md，已按 personal storage 尝试: ${String(e?.message || e).slice(0, 120)}`,
    };
  }
}

function parseAgentMdType(content: string): string | undefined {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^type\s*:\s*(.+)$/);
    if (!match) continue;
    return stripYamlScalar(match[1]);
  }
  return undefined;
}

function stripYamlScalar(value: string): string {
  let out = value.trim();
  const hash = out.indexOf(' #');
  if (hash >= 0) out = out.slice(0, hash).trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1);
  }
  return out.trim();
}

function parseRemoteRequired(value: string | undefined, opts: { command: string; allowEmptyPath?: boolean }): RemotePath {
  if (!value) {
    throw new FsCliError('INVALID_ARGUMENT', `用法: evolclaw fs ${opts.command} <AID>:<path>`);
  }
  const parsed = parseRemoteMaybe(value, opts.allowEmptyPath);
  if (!parsed) {
    throw new FsCliError('INVALID_PATH', `不是合法远程路径: ${value}`, '远程路径格式必须是 <AID>:<absolute-path>。');
  }
  return parsed;
}

function parseRemoteMaybe(value: string, allowEmptyPath = false): RemotePath | null {
  const idx = value.indexOf(':');
  if (idx <= 0) return null;
  const aid = value.slice(0, idx).trim();
  const remotePath = value.slice(idx + 1);
  if (!isValidAid(aid)) {
    if (remotePath.startsWith('/') || remotePath === '') {
      throw new FsCliError('INVALID_AID', `无效 AID: ${aid}`);
    }
    return null;
  }
  if (remotePath === '' && allowEmptyPath) {
    return { aid, path: '', raw: value };
  }
  if (!remotePath.startsWith('/')) {
    throw new FsCliError('INVALID_PATH', `远程路径必须是绝对路径: ${value}`, '请使用 <AID>:/path/to/file。');
  }
  return { aid, path: remotePath || '/', raw: value };
}

function remoteRef(p: RemotePath): string {
  return `${p.aid}:${p.path}`;
}

function linkTargetValue(target: string, linkOwner: string): string {
  const parsed = parseRemoteMaybe(target);
  if (parsed) {
    if (parsed.aid === linkOwner) return parsed.path;
    return remoteRef(parsed);
  }
  return target.replace(/\\/g, '/');
}

function hasShortFlag(args: string[], flag: string): boolean {
  for (const arg of args) {
    if (!isShortOptionBundle(arg)) continue;
    if (arg.slice(1).includes(flag)) return true;
  }
  return false;
}

function isShortOptionBundle(arg: string): boolean {
  return /^-[A-Za-z]+$/.test(arg);
}

function collectPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (SHORT_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('--')) continue;
    if (isShortOptionBundle(arg)) continue;
    out.push(arg);
  }
  return out;
}

function firstPositional(args: string[]): string | undefined {
  return collectPositionals(args)[0];
}

function parseOptionalPositiveInt(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new FsCliError('INVALID_ARGUMENT', `${flagName} 必须是正整数: ${value}`);
  }
  return n;
}

function parseOptionalTimestamp(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.trunc(numeric);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new FsCliError('INVALID_ARGUMENT', `${flagName} 必须是 Unix 时间戳或 ISO 时间: ${value}`);
  }
  return Math.floor(ms / 1000);
}

function parseReadonly(args: string[]): boolean | undefined {
  if (args.includes('--rw') || args.includes('--readwrite') || args.includes('--read-write')) return false;
  if (args.includes('--readonly') || args.includes('--read-only')) return true;
  return undefined;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function positionalsTargetIndex(positionals: string[]): number {
  return positionals.length >= 2 && parseVisibility(positionals[0]) ? 1 : 0;
}

function parseVisibility(value: string | undefined): 'public' | 'private' | undefined {
  if (!value) return undefined;
  const mode = value.trim().toLowerCase();
  if (['public', '+r', 'a+r', 'o+r', 'go+r', 'ugo+r'].includes(mode)) return 'public';
  if (['private', '-r', 'a-r', 'o-r', 'go-r', 'ugo-r'].includes(mode)) return 'private';
  throw new FsCliError(
    'INVALID_ARGUMENT',
    `不支持的 chmod 模式: ${value}`,
    '当前 ec fs chmod 只支持 +r/o-r，或 --visibility public|private。'
  );
}

function parseAclSpec(value: string, requirePerms: true): [string, string];
function parseAclSpec(value: string, requirePerms: false): [string];
function parseAclSpec(value: string, requirePerms: boolean): [string, string?];
function parseAclSpec(value: string, requirePerms: boolean): [string, string?] {
  const parts = value.split(':');
  if (parts.length < 2 || parts[0] !== 'aid' || !parts[1]) {
    throw new FsCliError('INVALID_ARGUMENT', 'ACL 条目格式应为 aid:<AID>:<perms> 或 aid:<AID>');
  }
  if (requirePerms) {
    if (parts.length !== 3 || !parts[2]) {
      throw new FsCliError('INVALID_ARGUMENT', 'setfacl -m 格式应为 aid:<AID>:<perms>');
    }
    return [parts[1], parts[2]];
  }
  if (parts.length !== 2) {
    throw new FsCliError('INVALID_ARGUMENT', 'setfacl -x 格式应为 aid:<AID>');
  }
  return [parts[1]];
}

function assertLocalFile(localPath: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(localPath);
  } catch (e: any) {
    throw new FsCliError('LOCAL_IO_ERROR', `本地文件不存在: ${localPath}`, undefined, { cause: String(e?.message || e) });
  }
  if (!st.isFile()) {
    throw new FsCliError('LOCAL_IO_ERROR', `当前版本只支持上传单个文件: ${localPath}`);
  }
}

function extractItems(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.nodes)) return value.nodes;
  if (Array.isArray(value?.entries)) return value.entries;
  if (Array.isArray(value?.result?.items)) return value.result.items;
  if (Array.isArray(value?.result?.nodes)) return value.result.nodes;
  return [];
}

function printList(target: RemotePath, value: any): void {
  const items = extractItems(value);
  if (items.length === 0) {
    console.log(`(空) ${remoteRef(target)}`);
    return;
  }
  for (const item of items) {
    const path = printableItemPath(target.aid, item);
    const type = String(item?.type ?? item?.node_type ?? item?.kind ?? '-');
    const size = numberFrom(item, ['size', 'size_bytes', 'bytes']);
    const suffix = size !== undefined ? `  ${size} bytes` : '';
    console.log(`${type.padEnd(6)} ${path}${suffix}`);
  }
}

function printNode(ownerAid: string, node: any): void {
  const path = printableItemPath(ownerAid, node);
  const type = String(node?.type ?? node?.node_type ?? node?.kind ?? '-');
  const size = numberFrom(node, ['size', 'size_bytes', 'bytes']);
  const version = numberFrom(node, ['version', 'etag_version']);
  const mtime = numberFrom(node, ['mtime', 'updated_at', 'modified_at']);
  const contentType = contentTypeFrom(node);
  const target = node?.target ? String(node.target) : undefined;
  const mountSource = node?.mountSource ?? node?.mount_source;
  const visibility = node?.isPublic === true || node?.is_public === true || node?.is_private === false
    ? 'public'
    : node?.isPublic === false || node?.is_private === true
      ? 'private'
      : undefined;

  console.log(`${type.padEnd(8)} ${path}`);
  if (size !== undefined) console.log(`  Size: ${formatBytes(size)} (${size} bytes)`);
  if (contentType) console.log(`  Type: ${contentType}`);
  if (visibility) console.log(`  Visibility: ${visibility}`);
  if (version !== undefined) console.log(`  Version: ${version}`);
  if (mtime !== undefined) console.log(`  Modified: ${formatTimestamp(mtime)}`);
  if (target) console.log(`  Target: ${target}`);
  if (mountSource) console.log(`  Mount: ${String(mountSource)}`);
  if (node?.mode) console.log(`  Mode: ${String(node.mode)}`);
}

function printableItemPath(ownerAid: string, item: any): string {
  const raw = String(item?.path ?? item?.key ?? item?.object_key ?? item?.name ?? '');
  if (!raw) return `${ownerAid}:/`;
  if (raw.includes(':/')) return raw;
  return `${ownerAid}:${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function printUsage(aid: string, usage: any): void {
  const quota = numberFrom(usage, ['quotaBytes', 'quota_bytes', 'quota', 'size']);
  const used = numberFrom(usage, ['usedBytes', 'used_bytes', 'used']);
  const avail = numberFrom(usage, ['availBytes', 'avail_bytes', 'available', 'free']);
  const count = numberFrom(usage, ['objectCount', 'object_count', 'objects']);
  console.log(`Filesystem: ${aid}:`);
  if (quota !== undefined) console.log(`  Quota: ${formatBytes(quota)}`);
  if (used !== undefined) console.log(`  Used:  ${formatBytes(used)}`);
  if (avail !== undefined) console.log(`  Avail: ${formatBytes(avail)}`);
  if (count !== undefined) console.log(`  Objects: ${count}`);
  if (quota === undefined && used === undefined && avail === undefined && count === undefined) {
    console.log(JSON.stringify(usage, null, 2));
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)}TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function formatTimestamp(value: number): string {
  const ms = value > 10_000_000_000 ? value : value * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

function numberFrom(value: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = value?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function contentTypeFrom(value: any): string | undefined {
  const raw = value?.contentType ?? value?.content_type ?? value?.mime ?? value?.mime_type;
  return raw ? String(raw).toLowerCase() : undefined;
}

function bytesFromDownload(value: any): Uint8Array {
  const data = value?.data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new FsCliError('BACKEND_ERROR', '下载接口未返回字节内容', undefined, value);
}

function looksBinary(bytes: Uint8Array, contentType?: string): boolean {
  if (contentType) {
    if (contentType.startsWith('text/')) return false;
    if (['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript'].includes(contentType)) return false;
    if (contentType && contentType !== 'application/octet-stream') return true;
  }
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4096));
  if (sample.includes(0)) return true;
  let control = 0;
  for (const b of sample) {
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) control++;
  }
  return sample.length > 0 && control / sample.length > 0.08;
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FsCliError('BINARY_FILE', `文件不是有效 UTF-8 文本: ${path}`, `请使用 evolclaw fs cp ${path} <local-path> 下载。`);
  }
}

function outputSuccess(opts: CommonOptions, payload: Record<string, unknown>, human: () => void): void {
  if (opts.formatJson) {
    console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
    return;
  }
  const route = payload.route as RouteInfo | undefined;
  if (route?.warning) {
    console.error(`⚠ ${route.warning}`);
  }
  human();
}

function outputError(error: any, formatJson: boolean): void {
  const e = error instanceof FsCliError ? error : mapBackendError(error);
  if (formatJson) {
    console.log(JSON.stringify({
      ok: false,
      code: e.code,
      error: e.message,
      suggestion: e.suggestion,
      details: e.details,
    }, null, 2));
    return;
  }
  console.error(`✗ ${e.message}`);
  if (e.suggestion) console.error(`  ${e.suggestion}`);
}

function mapBackendError(error: any): FsCliError {
  if (error instanceof FsCliError) return error;
  const code = String(error?.code ?? error?.name ?? 'BACKEND_ERROR');
  const message = String(error?.message || error);
  const upper = code.toUpperCase();
  if (upper.includes('ENOENT') || upper.includes('NOT_FOUND')) {
    return new FsCliError('NOT_FOUND', message);
  }
  if (upper.includes('EACCES') || upper.includes('FORBIDDEN') || upper.includes('UNAUTHORIZED')) {
    return new FsCliError('EACCES', message, '请确认操作者 AID 具备该路径权限。');
  }
  if (upper.includes('EEXIST')) {
    return new FsCliError('EEXIST', message, '如需覆盖，请添加 --overwrite。');
  }
  if (upper.includes('EISDIR')) {
    return new FsCliError('EISDIR', message);
  }
  if (upper.includes('EUNSUPPORTED') || upper.includes('UNSUPPORTED')) {
    return new FsCliError('UNSUPPORTED', message);
  }
  return new FsCliError('BACKEND_ERROR', message, undefined, { code: error?.code, data: error?.data });
}
