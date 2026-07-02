import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolvePaths,
  resolveRoot,
  _resetRoot,
  agentRelationsDir,
  agentIdentitiesDir,
  agentIndexDir,
  kitsRulesDir,
  kitsDocsDir,
  kitsTemplatesDir,
  getPackageRoot,
} from '../../src/paths.js';

describe('paths', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eck-paths-'));
    originalHome = process.env.EVOLCLAW_HOME;
    process.env.EVOLCLAW_HOME = tmpDir;
    _resetRoot();
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

  it('resolvePaths includes eckDir', () => {
    const p = resolvePaths();
    expect(p.eckDir).toBe(path.join(tmpDir, 'eck'));
  });

  it('resolvePaths includes processConfig', () => {
    const p = resolvePaths();
    expect(p.processConfig).toBe(path.join(tmpDir, 'config.json'));
  });

  it('resolvePaths does not include kitsDir', () => {
    const p = resolvePaths() as any;
    expect(p.kitsDir).toBeUndefined();
  });

  it('agentRelationsDir returns relations path', () => {
    expect(agentRelationsDir('test.agentid.pub')).toBe(
      path.join(tmpDir, 'agents', 'test.agentid.pub', 'relations')
    );
  });

  it('agentIdentitiesDir is deprecated alias for agentRelationsDir', () => {
    expect(agentIdentitiesDir('test.agentid.pub')).toBe(
      agentRelationsDir('test.agentid.pub')
    );
  });

  it('agentIndexDir returns index path', () => {
    expect(agentIndexDir('test.agentid.pub')).toBe(
      path.join(tmpDir, 'agents', 'test.agentid.pub', 'index')
    );
  });

  it('kitsRulesDir points to package root', () => {
    const result = kitsRulesDir();
    expect(result).toContain('kits');
    expect(result).toContain('rules');
    expect(result).toBe(path.join(getPackageRoot(), 'kits', 'rules'));
  });

  it('kitsDocsDir points to package root', () => {
    expect(kitsDocsDir()).toBe(path.join(getPackageRoot(), 'kits', 'docs'));
  });

  it('kitsTemplatesDir points to package root', () => {
    expect(kitsTemplatesDir()).toBe(path.join(getPackageRoot(), 'kits', 'templates'));
  });
});
