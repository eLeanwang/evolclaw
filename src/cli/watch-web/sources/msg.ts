/**
 * 消息数据源 — 复用 watch-msg.ts 的数据层函数 + fs.watch 文件监听。
 *
 * snapshot:
 *   - 无 aid: 返回本地 AID 列表（含收发统计）
 *   - 有 aid 无 peer: 返回该 AID 的对端列表 + 全部消息
 *   - 有 aid 有 peer: 返回该对端的消息
 * subscribe: fs.watch(sessions/aun, recursive)，messages.jsonl 变化时防抖 150ms 后重推。
 */

import fs from 'fs';
import {
  getSessionsAunDir,
  listLocalAids,
  loadAidInfo,
  loadPeerInfos,
  loadAllMessages,
  readMessages,
} from '../../watch-msg.js';
import type { WatchSource } from './types.js';

function buildSnapshot(params: Record<string, any>): any {
  const aunDir = getSessionsAunDir();
  if (!fs.existsSync(aunDir)) {
    return { aids: [], peers: [], messages: [], aid: null, peer: null };
  }

  const aid: string | null = params.aid || null;
  const peer: string | null = params.peer || null;

  const aids = listLocalAids(aunDir)
    .map(a => loadAidInfo(aunDir, a))
    .sort((a, b) => (b.totalIn + b.totalOut) - (a.totalIn + a.totalOut));

  if (!aid) {
    return { aids, peers: [], messages: [], aid: null, peer: null };
  }

  const peers = loadPeerInfos(aunDir, aid);
  let messages;
  if (peer) {
    messages = readMessages(aunDir, aid, peer);
    if (messages.length > 1000) messages = messages.slice(-1000);
  } else {
    messages = loadAllMessages(aunDir, aid);
  }

  return { aids, peers, messages, aid, peer };
}

export const msgSource: WatchSource = {
  kind: 'msg',

  async snapshot(params: Record<string, any> = {}): Promise<any> {
    return buildSnapshot(params);
  },

  subscribe(params: Record<string, any>, push: (data: any) => void): () => void {
    const aunDir = getSessionsAunDir();
    let watcher: fs.FSWatcher | null = null;
    let debounce: NodeJS.Timeout | null = null;

    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try { push(buildSnapshot(params)); } catch { /* ignore */ }
      }, 150);
    };

    try {
      watcher = fs.watch(aunDir, { recursive: true }, (_evt, filename) => {
        if (filename && String(filename).endsWith('messages.jsonl')) fire();
      });
    } catch { /* aunDir may not exist yet */ }

    return () => {
      if (watcher) watcher.close();
      if (debounce) clearTimeout(debounce);
    };
  },
};
