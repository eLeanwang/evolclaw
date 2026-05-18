import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { EventBus } from '../../src/core/event-bus.js';

describe('SessionManager (fs backend)', () => {
  let tmpDir: string;
  let mgr: SessionManager;
  let bus: EventBus;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fs-'));
    bus = new EventBus();
    mgr = new SessionManager(tmpDir, bus);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getOrCreateSession', () => {
    it('creates new session on first call', async () => {
      const s = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/proj');
      expect(s.channel).toBe('feishu_main');
      expect(s.channelId).toBe('oc_a');
      expect(s.projectPath).toBe('/proj');
      expect(s.id).toMatch(/^meta_\d{8}_\d+$/);
      expect(fs.existsSync(path.join(tmpDir, 'feishu_main', 'oc_a', 'active.json'))).toBe(true);
    });

    it('returns same session on second call', async () => {
      const s1 = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/proj');
      const s2 = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/proj');
      expect(s2.id).toBe(s1.id);
    });

    it('isolates sessions across chats', async () => {
      const a = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/proj');
      const b = await mgr.getOrCreateSession('feishu_main', 'oc_b', '/proj');
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('createNewSession + listSessions', () => {
    it('lists all sessions in chat ordered by updatedAt desc', async () => {
      await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p1');
      await new Promise(r => setTimeout(r, 5));
      await mgr.createNewSession('feishu_main', 'oc_a', '/p2', 'second');
      await new Promise(r => setTimeout(r, 5));
      await mgr.createNewSession('feishu_main', 'oc_a', '/p3', 'third');

      const list = await mgr.listSessions('feishu_main', 'oc_a');
      expect(list.length).toBe(3);
      expect(list[0].name).toBe('third');
    });
  });

  describe('renameSession', () => {
    it('updates name and persists', async () => {
      const s = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p');
      const ok = await mgr.renameSession(s.id, '新名字');
      expect(ok).toBe(true);

      const active = await mgr.getActiveSession('feishu_main', 'oc_a');
      expect(active?.name).toBe('新名字');
    });
  });

  describe('switchToSession', () => {
    it('switches active.json to target session', async () => {
      const a = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p1', undefined, undefined, 'A');
      const b = await mgr.createNewSession('feishu_main', 'oc_a', '/p2', 'B');

      let active = await mgr.getActiveSession('feishu_main', 'oc_a');
      expect(active?.name).toBe('B');

      const result = await mgr.switchToSession('feishu_main', 'oc_a', a.id);
      expect(result?.id).toBe(a.id);

      active = await mgr.getActiveSession('feishu_main', 'oc_a');
      expect(active?.id).toBe(a.id);
    });

    it('returns null for unknown session', async () => {
      const r = await mgr.switchToSession('feishu_main', 'oc_a', 'nope');
      expect(r).toBeNull();
    });
  });

  describe('thread sessions', () => {
    it('creates separate session for thread', async () => {
      const main = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p');
      const thread = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p', 'thread-1');

      expect(thread.threadId).toBe('thread-1');
      expect(thread.id).not.toBe(main.id);

      const indexPath = path.join(tmpDir, 'feishu_main', 'oc_a', '_threads', 'thread-index.json');
      expect(fs.existsSync(indexPath)).toBe(true);
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      expect(index['thread-1']).toBe(thread.id);
    });

    it('getThreadSession finds existing thread', async () => {
      await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p', 'thread-1');
      const found = await mgr.getThreadSession('feishu_main', 'oc_a', 'thread-1');
      expect(found?.threadId).toBe('thread-1');
    });
  });

  describe('processing state', () => {
    it('markProcessing / clearProcessing', async () => {
      const s = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p');

      mgr.markProcessing(s.id, 'task-1');
      expect(mgr.getActiveTaskId(s.id)).toBe('task-1');

      mgr.clearProcessing(s.id);
      expect(mgr.getActiveTaskId(s.id)).toBeUndefined();
    });

    it('getPendingProcessingSessions returns only processing', async () => {
      const a = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p');
      await mgr.createNewSession('feishu_main', 'oc_b', '/p');

      mgr.markProcessing(a.id, 't1');
      const pending = mgr.getPendingProcessingSessions();
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(a.id);
    });
  });

  describe('health records', () => {
    it('recordSuccess updates lastSuccessTime and clears errors', async () => {
      const s = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p');
      await mgr.recordError(s.id, 'infra:timeout', 'timed out');
      await mgr.recordError(s.id, 'infra:timeout', 'again');
      let h = await mgr.getHealthStatus(s.id);
      expect(h.consecutiveErrors).toBe(2);

      await mgr.recordSuccess(s.id);
      h = await mgr.getHealthStatus(s.id);
      expect(h.consecutiveErrors).toBe(0);
    });

    it('resetHealthStatus clears counter', async () => {
      const s = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p');
      await mgr.recordError(s.id, 'infra:timeout', 'x');
      await mgr.resetHealthStatus(s.id);
      const h = await mgr.getHealthStatus(s.id);
      expect(h.consecutiveErrors).toBe(0);
    });
  });

  describe('unbindSession', () => {
    it('moves meta file to _trash', async () => {
      const a = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p1');
      const b = await mgr.createNewSession('feishu_main', 'oc_a', '/p2');

      const ok = await mgr.unbindSession(a.id);
      expect(ok).toBe(true);

      const list = await mgr.listSessions('feishu_main', 'oc_a');
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(b.id);

      const trashDir = path.join(tmpDir, 'feishu_main', 'oc_a', '_trash');
      const trashed = fs.readdirSync(trashDir);
      expect(trashed.length).toBe(1);
    });
  });

  describe('persistence across instances', () => {
    it('reload from disk', async () => {
      const s = await mgr.getOrCreateSession('feishu_main', 'oc_a', '/p');
      await mgr.renameSession(s.id, '持久化');

      const mgr2 = new SessionManager(tmpDir, new EventBus());
      const active = await mgr2.getActiveSession('feishu_main', 'oc_a');
      expect(active?.id).toBe(s.id);
      expect(active?.name).toBe('持久化');
    });
  });

  describe('selfId', () => {
    it('persists selfId on creation', async () => {
      const s = await mgr.getOrCreateSession(
        'aun_main', 'alice.agentid.pub', '/p',
        undefined, undefined, undefined, 'alice.agentid.pub', 'private',
        undefined, 'self.agentid.pub', 'aun'
      );
      expect(s.selfId).toBe('self.agentid.pub');

      const mgr2 = new SessionManager(tmpDir, new EventBus());
      const active = await mgr2.getActiveSession('aun_main', 'alice.agentid.pub');
      expect(active?.selfId).toBe('self.agentid.pub');
    });

    it('backfills selfId on existing session when channel reports it', async () => {
      const s1 = await mgr.getOrCreateSession(
        'aun_main', 'alice.agentid.pub', '/p',
        undefined, undefined, undefined, undefined, 'private',
        undefined, undefined, 'aun'
      );
      expect(s1.selfId).toBeUndefined();

      const s2 = await mgr.getOrCreateSession(
        'aun_main', 'alice.agentid.pub', '/p',
        undefined, undefined, undefined, 'alice.agentid.pub', 'private',
        undefined, 'self.agentid.pub', 'aun'
      );
      expect(s2.selfId).toBe('self.agentid.pub');
      expect(s2.id).toBe(s1.id);
    });
  });
});
