import fs from 'fs';
import path from 'path';
import type { AIDStore, AUNClient, AID } from '@agentunion/fastaun';

/**
 * Slot 命名约定（基于 fastaun 0.4.3 隔离键语义）。
 *
 * slotIsolationKey 取第一个分隔符（空格/'/'/':'）之前的部分作为隔离键，
 * 隔离键相同 = 共享消费通道（token / seq 游标 / 消息过滤）。
 *
 *   'evolclaw daemon'   → 隔离键 'evolclaw'   ┐
 *   'evolclaw cli'      → 隔离键 'evolclaw'   ├ 共享 evolclaw 消费通道
 *   'evolclaw netcheck' → 隔离键 'evolclaw'   ┘
 *   'evolclaw-bench'    → 隔离键 'evolclaw-bench'（连字符非分隔符）→ 独立通道
 *
 * 设计意图：
 *  - daemon 长连接 + cli 短连接共存于 evolclaw 通道（1 长 + N 短，短连接不踢长连接）
 *  - netcheck 长连接抢 evolclaw 长连接位 → 踢掉 daemon（用于踢人/extra_info 测试）
 *  - bench 各并发单元用 evolclaw-bench-<N>，各自独立隔离键，互不干扰
 */
export const SLOT = {
  daemon: 'evolclaw daemon',
  cli: 'evolclaw cli',
  bench: 'evolclaw-bench',
  netcheck: 'evolclaw netcheck',
} as const;

/** 加载身份失败时抛出，携带 SDK 的错误码与消息。 */
export class AidLoadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AidLoadError';
    this.code = code;
  }
}

export interface GetAidStoreOpts {
  /** slot 标识，调用方明确自己属于哪个消费通道（SLOT.daemon / SLOT.cli / ...）。 */
  slotId: string;
  /** keystore 根目录，默认走 paths.aunPath()。 */
  aunPath?: string;
  /** 是否输出 SDK DEBUG 日志（含文件日志）。 */
  debug?: boolean;
}

/**
 * 统一构造 AIDStore。
 *
 * 接管旧 createAunClient 的职责：注入 encryptionSeed、rootCaPath、debug、slotId。
 * deviceId 不传 —— 由 SDK 从 {aunPath}/.device_id 读取或生成（同机共享）。
 */
export async function getAidStore(opts: GetAidStoreOpts): Promise<AIDStore> {
  const { aunPath: defaultAunPath } = await import('../../paths.js');
  const { loadProcessConfig } = await import('../../config-store.js');
  const { AIDStore } = await import('@agentunion/fastaun');

  const aunPath = opts.aunPath ?? defaultAunPath();
  const encryptionSeed = loadProcessConfig().aun?.encryptionSeed
    ?? process.env.AUN_ENCRYPTION_SEED
    ?? 'evol';
  const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');

  const storeOpts: any = {
    aunPath,
    encryptionSeed,
    slotId: opts.slotId,
    debug: opts.debug ?? false,
  };
  if (fs.existsSync(caCertPath)) storeOpts.rootCaPath = caCertPath;

  return new AIDStore(storeOpts);
}

/**
 * 从 store 加载本地身份并构造已就绪的 AUNClient（尚未连接）。
 *
 * load 失败（证书缺失/过期/链断裂/私钥不匹配等）抛 AidLoadError，携带 SDK 错误码。
 */
export async function loadClient(store: AIDStore, aid: string): Promise<AUNClient> {
  const { AUNClient } = await import('@agentunion/fastaun');
  return new AUNClient(loadAid(store, aid)) as AUNClient;
}

/** 加载本地 AID 值对象（用于离线签名/验签，无需连接）。load 失败抛 AidLoadError。 */
export function loadAid(store: AIDStore, aid: string): AID {
  const r = store.load(aid);
  if (!r.ok) throw new AidLoadError(r.error.code, r.error.message);
  return r.data.aid;
}
