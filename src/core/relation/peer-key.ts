/**
 * peerKey: 关系层路由键,格式 `<channelType>#<urlEncode(channelId)>`。
 * 群聊场景下 channelId = groupId,所有发言者共用同一个 peerKey。
 */
export function formatPeerKey(channelType: string, channelId: string): string {
  return `${channelType}#${encodeURIComponent(channelId)}`;
}

export function parsePeerKey(key: string): { channelType: string; channelId: string } {
  const idx = key.indexOf('#');
  if (idx <= 0) throw new Error(`Invalid peer key: ${key}`);
  return {
    channelType: key.slice(0, idx),
    channelId: decodeURIComponent(key.slice(idx + 1)),
  };
}
