import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWrite, atomicRead, atomicWriteJson, atomicReadJson } from '../../src/utils/atomic-write.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-atomic-'));
  return path.join(dir, 'foo.json');
}

describe('atomic-write', () => {
  it('writes and reads back', () => {
    const fp = tmpFile();
    atomicWriteJson(fp, { hello: 'world' });
    expect(atomicReadJson(fp)).toEqual({ hello: 'world' });
  });

  it('creates dirname if missing', () => {
    const fp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-atomic-')), 'a/b/c/foo.json');
    atomicWrite(fp, '{}');
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('returns null for missing file', () => {
    const fp = tmpFile();
    expect(atomicRead(fp)).toBeNull();
  });

  it('keeps a hot backup (foo.json_) after second write', () => {
    const fp = tmpFile();
    atomicWriteJson(fp, { v: 1 });
    atomicWriteJson(fp, { v: 2 });
    expect(fs.existsSync(fp + '_')).toBe(true);
    expect(JSON.parse(fs.readFileSync(fp + '_', 'utf-8'))).toEqual({ v: 1 });
    expect(JSON.parse(fs.readFileSync(fp, 'utf-8'))).toEqual({ v: 2 });
  });

  it('discards stale tmp (foo.json__) on read', () => {
    const fp = tmpFile();
    atomicWriteJson(fp, { v: 'good' });
    fs.writeFileSync(fp + '__', '{ corrupt');  // simulate crash mid-write
    const restored = atomicReadJson(fp);
    expect(restored).toEqual({ v: 'good' });
    expect(fs.existsSync(fp + '__')).toBe(false);
  });

  it('recovers from rename-step crash (only foo.json_ exists)', () => {
    const fp = tmpFile();
    atomicWriteJson(fp, { v: 'recoverable' });
    // simulate mid-rename crash: foo.json was renamed to foo.json_, but foo.json__
    // never got renamed back
    fs.renameSync(fp, fp + '_');
    expect(fs.existsSync(fp)).toBe(false);
    const restored = atomicReadJson(fp);
    expect(restored).toEqual({ v: 'recoverable' });
    expect(fs.existsSync(fp)).toBe(true);
  });
});
