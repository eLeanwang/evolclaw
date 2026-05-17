export interface AidStatsSnapshot {
  aid: string;
  selfName: string | null;
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastReceivedText: string | null;
  lastSentText: string | null;
  uniquePeerCount: number;
}

interface AidStatsEntry {
  aid: string;
  selfName: string | null;
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastReceivedText: string | null;
  lastSentText: string | null;
  uniquePeers: Set<string>;
}

export class AidStatsCollector {
  private entries = new Map<string, AidStatsEntry>();

  private getOrCreate(aid: string): AidStatsEntry {
    let entry = this.entries.get(aid);
    if (!entry) {
      entry = {
        aid,
        selfName: null,
        messagesReceived: 0,
        messagesSent: 0,
        bytesReceived: 0,
        bytesSent: 0,
        lastReceivedAt: null,
        lastSentAt: null,
        lastReceivedText: null,
        lastSentText: null,
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

  recordInbound(aid: string, fromPeer: string, byteLength: number, text?: string): void {
    const entry = this.getOrCreate(aid);
    entry.messagesReceived++;
    entry.bytesReceived += byteLength;
    entry.lastReceivedAt = Date.now();
    if (text) entry.lastReceivedText = text.length > 100 ? text.slice(0, 100) + '…' : text;
    entry.uniquePeers.add(fromPeer);
  }

  recordOutbound(aid: string, toPeer: string, byteLength: number, text?: string): void {
    const entry = this.getOrCreate(aid);
    entry.messagesSent++;
    entry.bytesSent += byteLength;
    entry.lastSentAt = Date.now();
    if (text) entry.lastSentText = text.length > 100 ? text.slice(0, 100) + '…' : text;
    entry.uniquePeers.add(toPeer);
  }

  getAllSnapshots(): AidStatsSnapshot[] {
    const out: AidStatsSnapshot[] = [];
    for (const entry of this.entries.values()) {
      out.push({
        aid: entry.aid,
        selfName: entry.selfName,
        messagesReceived: entry.messagesReceived,
        messagesSent: entry.messagesSent,
        bytesReceived: entry.bytesReceived,
        bytesSent: entry.bytesSent,
        lastReceivedAt: entry.lastReceivedAt,
        lastSentAt: entry.lastSentAt,
        lastReceivedText: entry.lastReceivedText,
        lastSentText: entry.lastSentText,
        uniquePeerCount: entry.uniquePeers.size,
      });
    }
    return out;
  }
}
