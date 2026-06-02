import type { Session, SessionMetadata } from '../../types.js';
import type { SessionFile } from './session-fs-store.js';
import { formatTimestamp } from './session-fs-store.js';
import { formatSessionKey, DEFAULT_THREAD_ID } from './session-key.js';

export function sessionToFile(session: Session): SessionFile {
  const metadata: Record<string, any> = {};
  if (session.metadata) {
    if (session.metadata.peerId) metadata.peerId = session.metadata.peerId;
    if (session.metadata.peerName) metadata.peerName = session.metadata.peerName;
    if (session.metadata.groupId) metadata.groupId = session.metadata.groupId;
    if (session.metadata.replyContext) metadata.replyContext = session.metadata.replyContext;
    if (session.metadata.agentSessions) metadata.agentSessions = session.metadata.agentSessions;
    if (session.metadata.resumeAt) metadata.resumeAt = session.metadata.resumeAt;
    for (const [k, v] of Object.entries(session.metadata)) {
      if (['isActive', 'channelKey', 'channelName', 'permissionMode', 'peerId', 'peerName', 'groupId', 'replyContext', 'agentSessions', 'resumeAt'].includes(k)) continue;
      if (v !== undefined) metadata[k] = v;
    }
  }

  const now = session.updatedAt || Date.now();
  const channelType = session.channelType || session.channel;
  const threadId = session.threadId || DEFAULT_THREAD_ID;
  return {
    id: session.id,
    channel: session.channel,
    channelType,
    channelId: session.channelId,
    sessionKey: formatSessionKey(channelType, session.channelId, threadId),
    selfAID: session.selfAID,
    agentType: session.agentId || 'claude',
    threadId: session.threadId || '',
    chatType: session.chatType || 'private',
    chatMode: session.sessionMode || 'interactive',
    projectPath: session.projectPath,
    agentSessionId: session.agentSessionId ?? null,
    name: session.name ?? null,
    activeTask: session.processingState ?? null,
    permissionMode: session.metadata?.permissionMode || 'auto',
    metadata,
    createdAt: session.createdAt,
    createdAtStr: formatTimestamp(session.createdAt),
    updatedAt: now,
    updatedAtStr: formatTimestamp(now),
  };
}

export function fileToSession(file: SessionFile): Session {
  const metadata: SessionMetadata = {};
  if (file.metadata.peerId) metadata.peerId = file.metadata.peerId;
  if (file.metadata.peerName) metadata.peerName = file.metadata.peerName;
  if (file.metadata.groupId) metadata.groupId = file.metadata.groupId;
  if (file.metadata.replyContext) metadata.replyContext = file.metadata.replyContext;
  if (file.metadata.agentSessions) metadata.agentSessions = file.metadata.agentSessions;
  if (file.metadata.resumeAt) metadata.resumeAt = file.metadata.resumeAt;
  if (file.permissionMode) metadata.permissionMode = file.permissionMode;

  for (const [k, v] of Object.entries(file.metadata)) {
    if (['peerId', 'peerName', 'groupId', 'replyContext', 'agentSessions', 'resumeAt'].includes(k)) continue;
    if (v !== undefined) (metadata as any)[k] = v;
  }

  return {
    id: file.id,
    channel: file.channel,
    channelType: file.channelType,
    channelId: file.channelId,
    sessionKey: file.sessionKey || formatSessionKey(file.channelType, file.channelId, file.threadId || DEFAULT_THREAD_ID),
    selfAID: file.selfAID,
    agentId: file.agentType,
    threadId: file.threadId,
    chatType: file.chatType,
    sessionMode: file.chatMode,
    projectPath: file.projectPath,
    agentSessionId: file.agentSessionId ?? undefined,
    name: file.name ?? undefined,
    processingState: file.activeTask ?? undefined,
    metadata,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}
