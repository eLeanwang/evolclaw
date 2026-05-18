import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  chatDirPath,
  decodeDirSegment,
  generateSessionId,
  formatTimestamp,
  atomicWriteJson,
  appendJsonl,
  readJsonFile,
  readLastJsonlLine,
  readAllJsonlLines,
  scanChatDirs,
  scanMetaFiles,
  ensureChatDir,
  readThreadIndex,
  writeThreadIndex,
} from '../../src/core/session/session-fs-store.js';

describe('session-fs-store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsstore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('chatDirPath', () => {
    it('non-aun: {channelType}/{encoded(channelId)}', () => {
      const p = chatDirPath(tmpDir, 'feishu', 'oc_abc');
      expect(p).toBe(path.join(tmpDir, 'feishu', 'oc_abc'));
    });

    it('aun: aun/{encoded(selfId)}/{encoded(channelId)}', () => {
      const p = chatDirPath(tmpDir, 'aun', 'alice.agentid.pub', 'self.agentid.pub');
      expect(p).toBe(path.join(tmpDir, 'aun', 'self.agentid.pub', 'alice.agentid.pub'));
    });

    it('encodes filesystem-unsafe characters', () => {
      const p = chatDirPath(tmpDir, 'aun', 'group.issuer.com/grp_001', 'self.aid');
      // / 被编码为 %2F
      const last = path.basename(p);
      expect(last).not.toMatch(/[<>:"/\\|?*]/);
      expect(decodeDirSegment(last)).toBe('group.issuer.com/grp_001');
    });

    it('aun without selfId uses _unknown', () => {
      const p = chatDirPath(tmpDir, 'aun', 'alice.agentid.pub');
      expect(p).toBe(path.join(tmpDir, 'aun', '_unknown', 'alice.agentid.pub'));
    });

    it('encodes percent for round-trip', () => {
      const p = chatDirPath(tmpDir, 'feishu', 'has%percent');
      expect(decodeDirSegment(path.basename(p))).toBe('has%percent');
    });
  });

  describe('generateSessionId / formatTimestamp', () => {
    it('generates id with correct format', () => {
      const ts = new Date('2024-05-21T10:00:00').getTime();
      const id = generateSessionId(ts);
      expect(id).toMatch(/^meta_\d{8}_\d+$/);
      expect(id).toContain('20240521');
      expect(id).toContain(`_${ts}`);
    });

    it('formats timestamp as YYYY-MM-DD HH:mm:ss', () => {
      const ts = new Date(2024, 4, 21, 10, 0, 0).getTime();
      expect(formatTimestamp(ts)).toBe('2024-05-21 10:00:00');
    });
  });

  describe('atomicWriteJson / readJsonFile', () => {
    it('writes and reads back JSON', () => {
      const filePath = path.join(tmpDir, 'data.json');
      atomicWriteJson(filePath, { foo: 'bar', n: 42 });
      expect(readJsonFile(filePath)).toEqual({ foo: 'bar', n: 42 });
    });

    it('overwrites existing file atomically', () => {
      const filePath = path.join(tmpDir, 'data.json');
      atomicWriteJson(filePath, { v: 1 });
      atomicWriteJson(filePath, { v: 2 });
      expect(readJsonFile<{ v: number }>(filePath)?.v).toBe(2);
    });

    it('returns undefined for missing file', () => {
      expect(readJsonFile(path.join(tmpDir, 'missing.json'))).toBeUndefined();
    });

    it('returns undefined for corrupt JSON', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, '{not json}');
      expect(readJsonFile(filePath)).toBeUndefined();
    });

    it('cleans up tmp file after rename', () => {
      const filePath = path.join(tmpDir, 'data.json');
      atomicWriteJson(filePath, { a: 1 });
      expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    });
  });

  describe('appendJsonl / readLastJsonlLine / readAllJsonlLines', () => {
    it('appends lines and reads last line', () => {
      const filePath = path.join(tmpDir, 'log.jsonl');
      appendJsonl(filePath, { v: 1 });
      appendJsonl(filePath, { v: 2 });
      appendJsonl(filePath, { v: 3 });
      expect(readLastJsonlLine<{ v: number }>(filePath)?.v).toBe(3);
    });

    it('reads all lines in order', () => {
      const filePath = path.join(tmpDir, 'log.jsonl');
      appendJsonl(filePath, { v: 1 });
      appendJsonl(filePath, { v: 2 });
      const all = readAllJsonlLines<{ v: number }>(filePath);
      expect(all).toEqual([{ v: 1 }, { v: 2 }]);
    });

    it('skips corrupt lines and uses last valid', () => {
      const filePath = path.join(tmpDir, 'log.jsonl');
      appendJsonl(filePath, { v: 1 });
      fs.appendFileSync(filePath, '{not valid json}\n');
      appendJsonl(filePath, { v: 3 });
      expect(readLastJsonlLine<{ v: number }>(filePath)?.v).toBe(3);
      expect(readAllJsonlLines<{ v: number }>(filePath)).toEqual([{ v: 1 }, { v: 3 }]);
    });

    it('returns undefined / empty for missing file', () => {
      expect(readLastJsonlLine(path.join(tmpDir, 'missing.jsonl'))).toBeUndefined();
      expect(readAllJsonlLines(path.join(tmpDir, 'missing.jsonl'))).toEqual([]);
    });
  });

  describe('scanChatDirs / scanMetaFiles', () => {
    it('lists non-aun chat dirs', () => {
      ensureChatDir(tmpDir, 'feishu', 'oc_a');
      ensureChatDir(tmpDir, 'feishu', 'oc_b');
      ensureChatDir(tmpDir, 'wechat', 'wx_user_1');
      const dirs = scanChatDirs(tmpDir);
      expect(dirs.length).toBe(3);
      expect(dirs.map(d => d.channelType).sort()).toEqual(['feishu', 'feishu', 'wechat']);
      expect(dirs.map(d => d.channelId).sort()).toEqual(['oc_a', 'oc_b', 'wx_user_1']);
      expect(dirs.every(d => d.selfId === null)).toBe(true);
    });

    it('lists aun chat dirs with selfId', () => {
      ensureChatDir(tmpDir, 'aun', 'alice.aid', 'self.aid');
      ensureChatDir(tmpDir, 'aun', 'bob.aid', 'self.aid');
      ensureChatDir(tmpDir, 'aun', 'alice.aid', 'other.self');
      const dirs = scanChatDirs(tmpDir);
      expect(dirs.length).toBe(3);
      expect(dirs.every(d => d.channelType === 'aun')).toBe(true);
      const selfIds = dirs.map(d => d.selfId).sort();
      expect(selfIds).toEqual(['other.self', 'self.aid', 'self.aid']);
    });

    it('returns empty for missing root', () => {
      expect(scanChatDirs(path.join(tmpDir, 'nope'))).toEqual([]);
    });

    it('lists meta_*.jsonl files only', () => {
      const chatDir = ensureChatDir(tmpDir, 'feishu', 'oc_a');
      fs.writeFileSync(path.join(chatDir, 'meta_20240521_1.jsonl'), '');
      fs.writeFileSync(path.join(chatDir, 'meta_20240522_2.jsonl'), '');
      fs.writeFileSync(path.join(chatDir, 'active.json'), '{}');
      fs.writeFileSync(path.join(chatDir, 'health.jsonl'), '');
      const files = scanMetaFiles(chatDir);
      expect(files).toEqual(['meta_20240521_1.jsonl', 'meta_20240522_2.jsonl']);
    });
  });

  describe('ensureChatDir', () => {
    it('creates chat dir + _threads + _trash (non-aun)', () => {
      const chatDir = ensureChatDir(tmpDir, 'feishu', 'oc_a');
      expect(fs.existsSync(chatDir)).toBe(true);
      expect(fs.existsSync(path.join(chatDir, '_threads'))).toBe(true);
      expect(fs.existsSync(path.join(chatDir, '_trash'))).toBe(true);
    });

    it('creates aun chat dir at correct depth', () => {
      const chatDir = ensureChatDir(tmpDir, 'aun', 'alice.aid', 'self.aid');
      expect(chatDir).toBe(path.join(tmpDir, 'aun', 'self.aid', 'alice.aid'));
      expect(fs.existsSync(chatDir)).toBe(true);
    });

    it('is idempotent', () => {
      ensureChatDir(tmpDir, 'feishu', 'oc_a');
      expect(() => ensureChatDir(tmpDir, 'feishu', 'oc_a')).not.toThrow();
    });
  });

  describe('readThreadIndex / writeThreadIndex', () => {
    it('reads empty when missing', () => {
      const chatDir = ensureChatDir(tmpDir, 'feishu', 'c');
      expect(readThreadIndex(chatDir)).toEqual({});
    });

    it('writes and reads back', () => {
      const chatDir = ensureChatDir(tmpDir, 'feishu', 'c');
      writeThreadIndex(chatDir, { t1: 'meta_20240521_1', t2: 'meta_20240522_2' });
      expect(readThreadIndex(chatDir)).toEqual({ t1: 'meta_20240521_1', t2: 'meta_20240522_2' });
    });
  });
});
