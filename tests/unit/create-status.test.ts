import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CreateStatusWriter, readCreateStatus, removeCreateStatus, type CreatePhase } from '../../src/core/message/create-status.js';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('CreateStatusWriter', () => {
  it('records phases and reaches ready', () => {
    const w = new CreateStatusWriter(tmpDir, 'x.agentid.pub');
    w.begin('validating');
    w.done('validating');
    w.begin('registering_aid');
    w.done('registering_aid', 'created');
    w.finishReady();
    const s = readCreateStatus(tmpDir)!;
    expect(s.status).toBe('ready');
    expect(s.steps.find(p => p.phase === 'validating')?.state).toBe('done');
    expect(s.steps.find(p => p.phase === 'registering_aid')?.detail).toBe('created');
  });

  it('marks warn but still ready (soft failure)', () => {
    const w = new CreateStatusWriter(tmpDir, 'x.agentid.pub');
    w.begin('uploading_agentmd');
    w.warn('uploading_agentmd', '3 次重试后仍失败');
    w.finishReady();
    const s = readCreateStatus(tmpDir)!;
    expect(s.status).toBe('ready');
    expect(s.steps.find(p => p.phase === 'uploading_agentmd')?.state).toBe('warn');
  });

  it('finishFailed sets failed + error (hard failure)', () => {
    const w = new CreateStatusWriter(tmpDir, 'x.agentid.pub');
    w.begin('registering_aid');
    w.finishFailed('registering_aid', 'AID creation failed: network');
    const s = readCreateStatus(tmpDir)!;
    expect(s.status).toBe('failed');
    expect(s.error).toContain('network');
    expect(s.steps.find(p => p.phase === 'registering_aid')?.state).toBe('failed');
  });

  it('readCreateStatus returns null when absent', () => {
    expect(readCreateStatus(tmpDir)).toBeNull();
  });

  it('removeCreateStatus deletes the file (idempotent)', () => {
    const w = new CreateStatusWriter(tmpDir, 'x.agentid.pub');
    w.finishReady();
    expect(readCreateStatus(tmpDir)).not.toBeNull();
    removeCreateStatus(tmpDir);
    expect(readCreateStatus(tmpDir)).toBeNull();
    // 再次删除不抛
    expect(() => removeCreateStatus(tmpDir)).not.toThrow();
  });
});
