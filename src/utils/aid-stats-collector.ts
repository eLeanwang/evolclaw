export interface AidStatsSnapshot {
  aid: string;
  selfName: string | null;
  messagesReceived: number;
  messagesSent: number;
  systemReceived: number;
  systemSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastReceivedText: string | null;
  lastReceivedFrom: string | null;
  lastSentText: string | null;
  lastSentTo: string | null;
  uniquePeerCount: number;
  processing: number;
  queued: number;
}

interface AidStatsEntry {
  aid: string;
  selfName: string | null;
  messagesReceived: number;
  messagesSent: number;
  systemReceived: number;
  systemSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastReceivedText: string | null;
  lastReceivedFrom: string | null;
  lastSentText: string | null;
  lastSentTo: string | null;
  uniquePeers: Set<string>;
}

export type QueueStatsProvider = (agentName: string) => { processing: number; queued: number };

export class AidStatsCollector {
  private entries = new Map<string, AidStatsEntry>();
  private queueStatsProvider?: QueueStatsProvider;

  setQueueStatsProvider(provider: QueueStatsProvider): void {
    this.queueStatsProvider = provider;
  }

  private getOrCreate(aid: string): AidStatsEntry {
    let entry = this.entries.get(aid);
    if (!entry) {
      entry = {
        aid,
        selfName: null,
        messagesReceived: 0,
        messagesSent: 0,
        systemReceived: 0,
        systemSent: 0,
        bytesReceived: 0,
        bytesSent: 0,
        lastReceivedAt: null,
        lastSentAt: null,
        lastReceivedText: null,
        lastReceivedFrom: null,
        lastSentText: null,
        lastSentTo: null,
        uniquePeers: new Set(),
      };
      this.entries.set(aid, entry);
    }
    return entry;
  }

  setSelfName(aid: string, name: string): void {
    const entry = this.getOrCreate(aid);
    entry.selfName = name;
  }

  recordInbound(aid: string, fromPeer: string, byteLength: number, text?: string, isSystem: boolean = false): void {
    const entry = this.getOrCreate(aid);
    if (isSystem) {
      entry.systemReceived++;
    } else {
      entry.messagesReceived++;
      entry.lastReceivedAt = Date.now();
      entry.lastReceivedFrom = fromPeer;
      if (text) entry.lastReceivedText = text.length > 100 ? text.slice(0, 100) + '…' : text;
    }
    entry.bytesReceived += byteLength;
    entry.uniquePeers.add(fromPeer);
  }

  recordOutbound(aid: string, toPeer: string, byteLength: number, text?: string, isSystem: boolean = false): void {
    const entry = this.getOrCreate(aid);
    if (isSystem) {
      entry.systemSent++;
    } else {
      entry.messagesSent++;
      entry.lastSentAt = Date.now();
      entry.lastSentTo = toPeer;
      if (text) entry.lastSentText = text.length > 100 ? text.slice(0, 100) + '…' : text;
    }
    entry.bytesSent += byteLength;
    entry.uniquePeers.add(toPeer);
  }

  getAllSnapshots(): AidStatsSnapshot[] {
    const out: AidStatsSnapshot[] = [];
    for (const entry of this.entries.values()) {
      const queueStats = this.queueStatsProvider
        ? this.queueStatsProvider(entry.aid)
        : { processing: 0, queued: 0 };
      out.push({
        aid: entry.aid,
        selfName: entry.selfName,
        messagesReceived: entry.messagesReceived,
        messagesSent: entry.messagesSent,
        systemReceived: entry.systemReceived,
        systemSent: entry.systemSent,
        bytesReceived: entry.bytesReceived,
        bytesSent: entry.bytesSent,
        lastReceivedAt: entry.lastReceivedAt,
        lastSentAt: entry.lastSentAt,
        lastReceivedText: entry.lastReceivedText,
        lastReceivedFrom: entry.lastReceivedFrom,
        lastSentText: entry.lastSentText,
        lastSentTo: entry.lastSentTo,
        uniquePeerCount: entry.uniquePeers.size,
        processing: queueStats.processing,
        queued: queueStats.queued,
      });
    }
    return out;
  }
}
