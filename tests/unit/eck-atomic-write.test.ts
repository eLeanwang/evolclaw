import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWriteText } from '../../src/utils/atomic-write.js';

describe('atomicWriteText', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eck-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes content to file', () => {
    const file = path.join(tmpDir, 'test.md');
    atomicWriteText(file, '# Hello\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('# Hello\n');
  });

  it('creates parent directories', () => {
    const file = path.join(tmpDir, 'a', 'b', 'c.md');
    atomicWriteText(file, 'deep');
    expect(fs.readFileSync(file, 'utf-8')).toBe('deep');
  });

  it('overwrites existing file atomically', () => {
    const file = path.join(tmpDir, 'test.md');
    fs.writeFileSync(file, 'old');
    atomicWriteText(file, 'new');
    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
  });

  it('does not leave .tmp files on success', () => {
    const file = path.join(tmpDir, 'test.md');
    atomicWriteText(file, 'content');
    const files = fs.readdirSync(tmpDir);
    expect(files.filter(f => f.includes('.tmp'))).toHaveLength(0);
  });
});
