import crypto from 'crypto';

export type ResponseDepth = 'lightweight' | 'standard' | 'deep';

export interface ResolveResponseDepthInput {
  chatType?: 'private' | 'group' | string;
  content?: string;
  selfAid?: string;
  mentionAids?: string[];
  dispatch?: string;
  topicRounds?: number;
  lastTopicHash?: string;
}

export interface ResolveResponseDepthResult {
  depth: ResponseDepth;
  topicHash: string;
  topicRounds: number;
  isMentioned: boolean;
}

export function computeTopicHash(content: string): string {
  const normalized = (content || '').trim().slice(0, 20);
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
}

export function resolveResponseDepth(input: ResolveResponseDepthInput): ResolveResponseDepthResult {
  const content = input.content || '';
  const topicHash = computeTopicHash(content);
  const previousRounds = input.topicRounds || 0;
  const topicRounds = input.lastTopicHash === topicHash ? previousRounds + 1 : 1;
  const isMentioned = !!input.selfAid && Array.isArray(input.mentionAids) && input.mentionAids.includes(input.selfAid);

  if (input.chatType !== 'group') {
    return { depth: 'standard', topicHash, topicRounds, isMentioned };
  }

  if (topicRounds >= 3) {
    return { depth: 'deep', topicHash, topicRounds, isMentioned };
  }

  if (isMentioned) {
    return { depth: 'standard', topicHash, topicRounds, isMentioned };
  }

  if (input.dispatch === 'broadcast' && isShortNonQuestion(content)) {
    return { depth: 'lightweight', topicHash, topicRounds, isMentioned };
  }

  return { depth: 'standard', topicHash, topicRounds, isMentioned };
}

function isShortNonQuestion(content: string): boolean {
  const text = (content || '').trim();
  if (text.length > 30) return false;
  if (/[?？]$/.test(text)) return false;
  return !/^(怎么|如何|为什么|为何|哪|谁|什么|是否|能否|可否|how\b|why\b|what\b|when\b|where\b|who\b|which\b|can\b|could\b|should\b|would\b|is\b|are\b|do\b|does\b|did\b)/i.test(text);
}
