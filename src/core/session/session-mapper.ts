import type { Session, SessionMetadata } from '../../types.js';
import type { SessionFile } from './session-fs-store.js';
import { formatTimestamp } from './session-fs-store.js';
import { formatSessionKey, DEFAULT_THREAD_ID } from './session-key.js';
import { logger } from '../../utils/logger.js';

export function sessionToFile(session: Session): SessionFile {
  const metadata: Record<string, any> = {};
  if (session.metadata) {
    if (session.metadata.peerId) metadata.peerId = session.metadata.peerId;
    if (session.metadata.peerName) metadata.peerName = session.metadata.peerName;
    if ((session.metadata as any).peerType) metadata.peerType = (session.metadata as any).peerType;
    if (session.metadata.groupId) metadata.groupId = session.metadata.groupId;
    if (session.metadata.replyContext) metadata.replyContext = session.metadata.replyContext;
    if (session.metadata.agentSessions) metadata.agentSessions = session.metadata.agentSessions;
    if (session.metadata.resumeAt) metadata.resumeAt = session.metadata.resumeAt;
    for (const [k, v] of Object.entries(session.metadata)) {
      if (['isActive', 'channelKey', 'channelName', 'permissionMode', 'peerId', 'peerName', 'peerType', 'groupId', 'replyContext', 'agentSessions', 'resumeAt'].includes(k)) continue;
      if (v !== undefined) metadata[k] = v;
    }
  }

  const now = session.updatedAt || Date.now();
  const channelType = session.channelType || session.channel;
  const threadId = session.threadId || DEFAULT_THREAD_ID;

  if (!session.baseagent) {
    throw new Error(`[session-mapper] sessionToFile: session.baseagent is empty for session ${session.id}`);
  }

  return {
    id: session.id,
    channel: session.channel,
    channelType,
    channelId: session.channelId,
    sessionKey: formatSessionKey(channelType, session.channelId, threadId),
    selfAID: session.selfAID,
    baseagent: session.baseagent,
    threadId: session.threadId || '',
    chatType: session.chatType || 'private',
    chatMode: session.chatMode || 'interactive',
    projectPath: session.projectPath,
    agentSessionId: session.agentSessionId ?? null,
    name: session.name ?? null,
    activeTask: session.processingState ?? null,
    metadata,
    createdAt: session.createdAt,
    createdAtStr: formatTimestamp(session.createdAt),
    updatedAt: now,
    updatedAtStr: formatTimestamp(now),
  };
}

export function fileToSession(file: SessionFile): Session {
  const metadata: SessionMetadata = {};

  // 兼容旧字段名 agentType → baseagent
  const baseagent = (file as any).baseagent || (file as any).agentType;
  if (!baseagent) {
    throw new Error(`[session-mapper] fileToSession: baseagent is empty for session ${file.id}`);
  }

  if (file.metadata.peerId) metadata.peerId = file.metadata.peerId;
  if (file.metadata.peerName) metadata.peerName = file.metadata.peerName;
  if (file.metadata.peerType) (metadata as any).peerType = file.metadata.peerType;
  if (file.metadata.groupId) metadata.groupId = file.metadata.groupId;
  if (file.metadata.replyContext) metadata.replyContext = file.metadata.replyContext;
  if (file.metadata.agentSessions) metadata.agentSessions = file.metadata.agentSessions;
  if (file.metadata.resumeAt) metadata.resumeAt = file.metadata.resumeAt;
  // permissionMode 不再从文件还原到 metadata（运行时 per-message 解析）

  for (const [k, v] of Object.entries(file.metadata)) {
    if (['peerId', 'peerName', 'peerType', 'groupId', 'replyContext', 'agentSessions', 'resumeAt', 'permissionMode'].includes(k)) continue;
    if (v !== undefined) (metadata as any)[k] = v;
  }

  return {
    id: file.id,
    channel: file.channel,
    channelType: file.channelType,
    channelId: file.channelId,
    sessionKey: file.sessionKey || formatSessionKey(file.channelType, file.channelId, file.threadId || DEFAULT_THREAD_ID),
    selfAID: file.selfAID,
    baseagent,
    threadId: file.threadId,
    chatType: file.chatType,
    chatMode: file.chatMode,
    projectPath: file.projectPath,
    agentSessionId: file.agentSessionId ?? undefined,
    name: file.name ?? undefined,
    processingState: file.activeTask ?? undefined,
    metadata,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}
