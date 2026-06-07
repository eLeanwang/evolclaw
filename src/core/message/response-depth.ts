import crypto from 'crypto';
import type { ResponseDepth } from '../../types.js';

/**
 * 响应深度决策的输入信号。由调用方从 message/session 中提取后传入。
 */
export interface ResponseDepthInput {
  chatType: string | undefined;
  content: string;
  selfAid: string | undefined;
  mentionAids: string[] | undefined;
  dispatch: string | undefined;
  topicRounds: number;
  lastTopicHash: string | undefined;
}

/**
 * 响应深度决策的输出：depth 枚举 + 更新后的话题追踪状态。
 */
export interface ResponseDepthResult {
  depth: ResponseDepth;
  topicRounds: number;
  topicHash: string;
}

/**
 * 计算消息内容的话题指纹（前 20 字符的 md5 前 8 位）。
 */
export function computeTopicHash(content: string): string {
  const slice = content.trim().slice(0, 20);
  return crypto.createHash('md5').update(slice).digest('hex').slice(0, 8);
}

/**
 * 群聊响应深度决策（纯函数，无 I/O）。
 *
 * 根据 dispatch 模式、消息特征（长度/是否问句/是否被@）、话题轮次综合判断。
 * 返回 depth 枚举 + 更新后的话题追踪状态（调用方负责持久化）。
 */
export function resolveResponseDepth(input: ResponseDepthInput): ResponseDepthResult {
  const { chatType, content, selfAid, mentionAids, dispatch, topicRounds: prevRounds, lastTopicHash } = input;

  // 仅群聊走深度决策；私聊一律 standard
  if (chatType !== 'group') {
    return { depth: 'standard', topicRounds: prevRounds, topicHash: lastTopicHash || '' };
  }

  const trimmed = content.trim();

  // ── 话题追踪：更新 topicRounds ──
  const topicHash = computeTopicHash(trimmed);
  let topicRounds: number;
  if (lastTopicHash && lastTopicHash === topicHash) {
    topicRounds = prevRounds + 1;
  } else {
    topicRounds = 1;
  }

  // ── 判断因子 ──
  const isMentioned = !!(selfAid && mentionAids?.includes(selfAid));
  const isQuestion = /[？?]\s*$/.test(trimmed) || /^(what|how|why|when|where|who|which|请问|怎么|为什么|什么|如何|能不能|可以)/i.test(trimmed);
  const isShort = trimmed.length <= 30;

  // ── 决策逻辑 ──

  // 被@：至少 standard；话题深入则升 deep
  if (isMentioned) {
    const depth = topicRounds >= 3 ? 'deep' : 'standard';
    return { depth, topicRounds, topicHash };
  }

  // broadcast 模式：短消息 + 非问句 → lightweight
  if (dispatch === 'broadcast') {
    let depth: ResponseDepth;
    if (topicRounds >= 3) depth = 'deep';
    else if (isShort && !isQuestion) depth = 'lightweight';
    else depth = 'standard';
    return { depth, topicRounds, topicHash };
  }

  // mention 模式下到达这里说明已通过 dispatch 过滤（被@才入队），
  // 等同于 isMentioned === true 的分支。兜底 standard。
  const depth: ResponseDepth = topicRounds >= 3 ? 'deep' : 'standard';
  return { depth, topicRounds, topicHash };
}
