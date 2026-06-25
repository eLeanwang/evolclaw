import crypto from 'crypto';
import { aidCreate } from './index.js';
import { getAidStore, SLOT } from './store.js';
import { logger } from '../../utils/logger.js';

const MAX_ATTEMPTS = 5;

/** 解析控制 AID 的 issuer：环境变量 EVOLCLAW_ISSUER → 兜底 agentid.pub */
export function resolveControlIssuer(): string {
  const env = process.env.EVOLCLAW_ISSUER?.trim();
  if (env) {
    // Validate issuer format: must be valid domain-like structure
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(env)) {
      logger.error(`[control-aid] Invalid EVOLCLAW_ISSUER format: ${env}, using default`);
      return 'agentid.pub';
    }
    // Prevent localhost/local domains
    if (env === 'localhost' || env.endsWith('.localhost') || env.startsWith('127.') || env.startsWith('0.')) {
      logger.error(`[control-aid] EVOLCLAW_ISSUER cannot be localhost/local: ${env}, using default`);
      return 'agentid.pub';
    }
    // Length limit
    if (env.length > 253) {
      logger.error(`[control-aid] EVOLCLAW_ISSUER too long: ${env.length} chars, using default`);
      return 'agentid.pub';
    }
  }
  return env || 'agentid.pub';
}

/** 生成候选控制 AID：ec + 5位随机数字 + .{issuer} */
export function candidateAid(issuer?: string): string {
  const n = crypto.randomInt(10000, 100000); // 5 位：10000-99999
  const finalIssuer = issuer || resolveControlIssuer();
  return `ec${n}.${finalIssuer}`;
}

export interface ControlAidResult {
  aid: string;
  gateway: string;
}

/**
 * 候选 AID 是否已在 PKI 注册。
 *
 * 不用 store.exists（它走 HTTP HEAD /pki/cert/<aid>）——部分 Gateway 实现
 * （Python websockets HTTP 处理）对 HEAD 直接空响应断连（curl 52 / socket hang up），
 * 导致 exists 误报"网关不可达"。改用 store.resolve（走 GET），语义等价且 GET 正常返回：
 *   - resolve ok            → 证书存在（HTTP 200）→ 已注册
 *   - CERT_NOT_FOUND        → 404 → 未注册
 *   - 其它 error            → 真·网络错误，向上抛出供 fail-fast
 * skipAgentMd:true 避免多拉一次 agent.md（控制 AID 本就不传 agent.md）。
 */
async function candidateExists(
  store: Awaited<ReturnType<typeof getAidStore>>,
  candidate: string,
): Promise<boolean> {
  const r = await store.resolve(candidate, { skipAgentMd: true });
  if (r.ok) return true;
  if (r.error?.code === 'CERT_NOT_FOUND') return false;
  throw new Error(`Gateway 不可达，无法查重控制 AID：${r.error?.message ?? 'unknown'}`);
}

/**
 * 生成控制 AID：循环候选 → candidateExists 查重（权威 PKI 判据）→ 不冲突则 aidCreate。
 * - 查重走 GET 证书（见 candidateExists；不拉 agent.md，控制 AID 本就不传 agent.md）
 * - fail-fast：查重探测失败（网关不可达）立即抛错，不掩盖成"均冲突"
 * - agent.md 不上传：aidCreate 仅注册身份 + 写私钥，不调 agentmdPut
 */
export async function generateControlAid(): Promise<ControlAidResult> {
  const issuer = resolveControlIssuer();
  const store = await getAidStore({ slotId: SLOT.cli });
  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const candidate = candidateAid(issuer);
      if (await candidateExists(store, candidate)) {
        logger.info(`[control-aid] ${candidate} 已注册，重试 (${i + 1}/${MAX_ATTEMPTS})`);
        continue;
      }
      const created = await aidCreate(candidate);
      // 清理 aidCreate 内部另开的 client/store——关闭失败不可丢弃已注册的 AID（否则下次 init
      // 会把它当冲突，白白消耗一次重试）。close 异常降级为 warn。
      try { await created.client?.close?.(); } catch (e) {
        logger.warn(`[control-aid] client.close() 失败（非致命）: ${e}`);
      }
      try { await created.store?.close?.(); } catch (e) {
        logger.warn(`[control-aid] store.close() 失败（非致命）: ${e}`);
      }
      return { aid: created.aid, gateway: created.gateway };
    }
    throw new Error(`无法生成控制 AID：连续 ${MAX_ATTEMPTS} 次候选均冲突`);
  } finally {
    store.close();
  }
}
