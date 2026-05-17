import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  writeMain,
  removeMain,
  writeRestartMonitor,
  removeRestartMonitor,
  appendAidEvent,
  removeAidLog,
  readAidLastActivity,
  scanInstances,
  cleanupInstances,
  removeAll,
} from '../../src/utils/instance-registry.js';
import { resolvePaths, _resetRoot } from '../../src/paths.js';

const TEST_HOME = path.join(os.tmpdir(), `evolclaw-test-${process.pid}-${Date.now()}`);

beforeEach(() => {
  process.env.EVOLCLAW_HOME = TEST_HOME;
  _resetRoot();
  fs.mkdirSync(path.join(TEST_HOME, 'data', 'instance'), { recursive: true });
});

afterEach(() => {
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {}
});

describe('instance-registry', () => {
  describe('writeMain / removeMain', () => {
    it('writes main-<pid>.json with correct content', () => {
      const filePath = writeMain('start');
      expect(filePath).toContain(`main-${process.pid}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(content.launchedBy).toBe('start');
      expect(content.startedAt).toBeTypeOf('number');
      expect(content.startedAtIso).toBeTypeOf('string');
    });

    it('removeMain deletes the file', () => {
      const filePath = writeMain('start');
      expect(fs.existsSync(filePath)).toBe(true);
      removeMain();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('removeMain is safe to call when file does not exist', () => {
      expect(() => removeMain()).not.toThrow();
    });
  });

  describe('writeRestartMonitor / removeRestartMonitor', () => {
    it('writes restart-monitor-<pid>.json', () => {
      const filePath = writeRestartMonitor();
      expect(filePath).toContain(`restart-monitor-${process.pid}.json`);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(content.launchedBy).toBe('restart-monitor');
    });

    it('removeRestartMonitor deletes the file', () => {
      const filePath = writeRestartMonitor();
      removeRestartMonitor();
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('appendAidEvent / readAidLastActivity / removeAidLog', () => {
    it('appends events as JSONL lines', () => {
      appendAidEvent({ ts: 1000, iso: '2026-01-01T00:00:00Z', event: 'connected', aid: 'alice.agentid.pub' });
      appendAidEvent({ ts: 2000, iso: '2026-01-01T00:00:02Z', event: 'message_in', aid: 'alice.agentid.pub' });

      const filePath = path.join(resolvePaths().instanceDir, `aid-${process.pid}.jsonl`);
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).event).toBe('connected');
      expect(JSON.parse(lines[1]).event).toBe('message_in');
    });

    it('readAidLastActivity returns last event per AID', () => {
      appendAidEvent({ ts: 1000, iso: '2026-01-01T00:00:00Z', event: 'connected', aid: 'alice.agentid.pub' });
      appendAidEvent({ ts: 2000, iso: '2026-01-01T00:00:02Z', event: 'message_in', aid: 'bob.agentid.pub' });
      appendAidEvent({ ts: 3000, iso: '2026-01-01T00:00:03Z', event: 'message_out', aid: 'alice.agentid.pub' });

      const activity = readAidLastActivity(process.pid);
      expect(activity.get('alice.agentid.pub')).toEqual({ ts: 3000, event: 'message_out' });
      expect(activity.get('bob.agentid.pub')).toEqual({ ts: 2000, event: 'message_in' });
    });

    it('readAidLastActivity returns empty map for non-existent file', () => {
      const activity = readAidLastActivity(99999);
      expect(activity.size).toBe(0);
    });

    it('removeAidLog deletes the file', () => {
      appendAidEvent({ ts: 1000, iso: '2026-01-01T00:00:00Z', event: 'connected', aid: 'test.agentid.pub' });
      removeAidLog();
      const filePath = path.join(resolvePaths().instanceDir, `aid-${process.pid}.jsonl`);
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('scanInstances', () => {
    it('returns empty status when directory is empty', () => {
      const status = scanInstances();
      expect(status.mains).toEqual([]);
      expect(status.restartMonitors).toEqual([]);
      expect(status.aidLastActivity.size).toBe(0);
    });

    it('detects current process as alive main', () => {
      writeMain('start');
      const status = scanInstances();
      expect(status.mains).toHaveLength(1);
      expect(status.mains[0].alive).toBe(true);
      expect(status.mains[0].record.pid).toBe(process.pid);
    });

    it('detects dead process as not alive', () => {
      const fakePid = 2147483647;
      const dir = resolvePaths().instanceDir;
      const record = { pid: fakePid, startedAt: Date.now(), startedAtIso: new Date().toISOString(), launchedBy: 'start' };
      fs.writeFileSync(path.join(dir, `main-${fakePid}.json`), JSON.stringify(record));

      const status = scanInstances();
      expect(status.mains).toHaveLength(1);
      expect(status.mains[0].alive).toBe(false);
    });

    it('returns multiple mains when several records exist', () => {
      const dir = resolvePaths().instanceDir;
      writeMain('start');
      const fakePid = 2147483646;
      fs.writeFileSync(
        path.join(dir, `main-${fakePid}.json`),
        JSON.stringify({ pid: fakePid, startedAt: Date.now(), startedAtIso: new Date().toISOString(), launchedBy: 'start' })
      );
      const status = scanInstances();
      expect(status.mains).toHaveLength(2);
      const pids = status.mains.map(m => m.record.pid).sort();
      expect(pids).toContain(process.pid);
      expect(pids).toContain(fakePid);
    });

    it('removes corrupted files during scan', () => {
      const dir = resolvePaths().instanceDir;
      fs.writeFileSync(path.join(dir, 'main-999.json'), 'not valid json{{{');
      const status = scanInstances();
      expect(status.mains).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'main-999.json'))).toBe(false);
    });
  });

  describe('cleanupInstances', () => {
    it('removes files for dead processes', () => {
      const fakePid = 2147483647;
      const dir = resolvePaths().instanceDir;
      const record = { pid: fakePid, startedAt: Date.now(), startedAtIso: new Date().toISOString(), launchedBy: 'start' };
      fs.writeFileSync(path.join(dir, `main-${fakePid}.json`), JSON.stringify(record));
      fs.writeFileSync(path.join(dir, `aid-${fakePid}.jsonl`), '{"ts":1,"iso":"x","event":"connected","aid":"a"}\n');

      const killed = cleanupInstances();
      expect(fs.existsSync(path.join(dir, `main-${fakePid}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `aid-${fakePid}.jsonl`))).toBe(false);
      expect(killed).toHaveLength(0);
    });

    it('cleans up .tmp files', () => {
      const dir = resolvePaths().instanceDir;
      fs.writeFileSync(path.join(dir, 'main-123.json.tmp'), 'partial write');
      cleanupInstances();
      expect(fs.existsSync(path.join(dir, 'main-123.json.tmp'))).toBe(false);
    });
  });

  describe('removeAll', () => {
    it('removes both main and aid files for current process', () => {
      writeMain('start');
      appendAidEvent({ ts: 1000, iso: '2026-01-01T00:00:00Z', event: 'connected', aid: 'test.agentid.pub' });

      const dir = resolvePaths().instanceDir;
      expect(fs.existsSync(path.join(dir, `main-${process.pid}.json`))).toBe(true);
      expect(fs.existsSync(path.join(dir, `aid-${process.pid}.jsonl`))).toBe(true);

      removeAll();
      expect(fs.existsSync(path.join(dir, `main-${process.pid}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `aid-${process.pid}.jsonl`))).toBe(false);
    });
  });
});
