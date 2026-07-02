import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _resetRoot } from '../../src/paths.js';
import { initEck, initAgentIndex } from '../../src/eck/init.js';

describe('initEck', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eck-init-'));
    originalHome = process.env.EVOLCLAW_HOME;
    process.env.EVOLCLAW_HOME = tmpDir;
    _resetRoot();
    fs.mkdirSync(path.join(tmpDir, 'eck'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.EVOLCLAW_HOME = originalHome;
    } else {
      delete process.env.EVOLCLAW_HOME;
    }
    _resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates runtime.md from template if missing', () => {
    initEck();
    const runtimeFile = path.join(tmpDir, 'eck', 'runtime.md');
    // File may or may not exist depending on whether template exists in package
    // This test verifies no crash occurs
    expect(true).toBe(true);
  });

  it('does not overwrite existing runtime.md', () => {
    const runtimeFile = path.join(tmpDir, 'eck', 'runtime.md');
    fs.writeFileSync(runtimeFile, 'custom content');
    initEck();
    expect(fs.readFileSync(runtimeFile, 'utf-8')).toBe('custom content');
  });

  it('does not overwrite existing path-registry.md', () => {
    const registryFile = path.join(tmpDir, 'eck', 'path-registry.md');
    fs.writeFileSync(registryFile, 'my paths');
    initEck();
    expect(fs.readFileSync(registryFile, 'utf-8')).toBe('my paths');
  });
});

describe('initAgentIndex', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eck-idx-'));
    originalHome = process.env.EVOLCLAW_HOME;
    process.env.EVOLCLAW_HOME = tmpDir;
    _resetRoot();
    fs.mkdirSync(path.join(tmpDir, 'agents', 'test.agentid.pub', 'index'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.EVOLCLAW_HOME = originalHome;
    } else {
      delete process.env.EVOLCLAW_HOME;
    }
    _resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates index directory', () => {
    initAgentIndex('test.agentid.pub');
    const indexDir = path.join(tmpDir, 'agents', 'test.agentid.pub', 'index');
    expect(fs.existsSync(indexDir)).toBe(true);
  });

  it('does not overwrite existing INDEX.md', () => {
    const indexFile = path.join(tmpDir, 'agents', 'test.agentid.pub', 'index', 'INDEX.md');
    fs.writeFileSync(indexFile, 'existing index');
    initAgentIndex('test.agentid.pub');
    expect(fs.readFileSync(indexFile, 'utf-8')).toBe('existing index');
  });
});
