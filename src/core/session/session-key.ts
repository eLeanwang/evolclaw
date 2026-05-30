/**
 * sessionKey: agent 内部会话路由键。
 * 格式: channelType#urlEncode(channelId)#urlEncode(threadId)
 * 无话题时 threadId 固定为 'main'。
 */
export const DEFAULT_THREAD_ID = 'main';

export function formatSessionKey(channelType: string, channelId: string, threadId?: string): string {
  const tid = threadId || DEFAULT_THREAD_ID;
  return `${channelType}#${encodeURIComponent(channelId)}#${encodeURIComponent(tid)}`;
}

export function parseSessionKey(key: string): { channelType: string; channelId: string; threadId: string } {
  const first = key.indexOf('#');
  if (first <= 0) throw new Error(`Invalid session key: ${key}`);
  const rest = key.slice(first + 1);
  const second = rest.indexOf('#');
  if (second <= 0) throw new Error(`Invalid session key (missing threadId): ${key}`);
  return {
    channelType: key.slice(0, first),
    channelId: decodeURIComponent(rest.slice(0, second)),
    threadId: decodeURIComponent(rest.slice(second + 1)),
  };
}
