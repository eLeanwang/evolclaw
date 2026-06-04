import crypto from 'crypto';
import { aidCreate } from './index.js';
import { getAidStore, SLOT } from './store.js';
import { logger } from '../../utils/logger.js';

const MAX_ATTEMPTS = 5;

/** 生成候选控制 AID：ec + 5位随机数字 + .agentid.pub */
export function candidateAid(): string {
  const n = crypto.randomInt(10000, 100000); // 5 位：10000-99999
  return `ec${n}.agentid.pub`;
}

export interface ControlAidResult {
  aid: string;
  gateway: string;
}

/**
 * 生成控制 AID：循环候选 → store.exists 查重（权威 PKI 判据）→ 不冲突则 aidCreate。
 * - 查重用 store.exists（HEAD 证书；不拉 agent.md，控制 AID 本就不传 agent.md）
 * - fail-fast：exists 探测失败（网关不可达）立即抛错，不掩盖成"均冲突"
 * - agent.md 不上传：aidCreate 仅注册身份 + 写私钥，不调 agentmdPut
 */
export async function generateControlAid(): Promise<ControlAidResult> {
  const store = await getAidStore({ slotId: SLOT.cli });
  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const candidate = candidateAid();
      const r = await store.exists(candidate);
      if (!r.ok) {
        throw new Error(`Gateway 不可达，无法查重控制 AID：${r.error?.message ?? 'unknown'}`);
      }
      if (r.data.exists) {
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
