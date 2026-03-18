import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot, _resetRoot } from '../../src/paths.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('paths', () => {
  const originalEnv = process.env.EVOLCLAW_HOME;

  beforeEach(() => {
    _resetRoot();
    delete process.env.EVOLCLAW_HOME;
  });

  afterEach(() => {
    _resetRoot();
    if (originalEnv !== undefined) {
      process.env.EVOLCLAW_HOME = originalEnv;
    } else {
      delete process.env.EVOLCLAW_HOME;
    }
  });

  describe('resolveRoot', () => {
    it('should default to ~/.evolclaw when no cwd config exists', () => {
      // cwd 下有 data/evolclaw.json 时会命中 cwd 检测，所以用 chdir 到临时目录
      const origCwd = process.cwd();
      const tmpDir = path.join(os.tmpdir(), `evolclaw-paths-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      process.chdir(tmpDir);
      try {
        const root = resolveRoot();
        expect(root).toBe(path.join(os.homedir(), '.evolclaw'));
      } finally {
        process.chdir(origCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should detect cwd when data/evolclaw.json exists', () => {
      const tmpDir = path.join(os.tmpdir(), `evolclaw-cwd-test-${Date.now()}`);
      fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'data', 'evolclaw.json'), '{}');
      const origCwd = process.cwd();
      process.chdir(tmpDir);
      try {
        const root = resolveRoot();
        expect(root).toBe(tmpDir);
      } finally {
        process.chdir(origCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should use EVOLCLAW_HOME env var when set', () => {
      process.env.EVOLCLAW_HOME = '/tmp/custom-evolclaw';
      const root = resolveRoot();
      expect(root).toBe('/tmp/custom-evolclaw');
    });

    it('should cache the result', () => {
      process.env.EVOLCLAW_HOME = '/tmp/first';
      const first = resolveRoot();
      process.env.EVOLCLAW_HOME = '/tmp/second';
      const second = resolveRoot();
      expect(first).toBe(second);
      expect(second).toBe('/tmp/first');
    });

    it('should return fresh value after _resetRoot', () => {
      process.env.EVOLCLAW_HOME = '/tmp/first';
      resolveRoot();
      _resetRoot();
      process.env.EVOLCLAW_HOME = '/tmp/second';
      expect(resolveRoot()).toBe('/tmp/second');
    });
  });

  describe('resolvePaths', () => {
    it('should return all expected path keys', () => {
      process.env.EVOLCLAW_HOME = '/tmp/test-evolclaw';
      const p = resolvePaths();
      expect(p.root).toBe('/tmp/test-evolclaw');
      expect(p.config).toBe('/tmp/test-evolclaw/data/evolclaw.json');
      expect(p.configSample).toBe('/tmp/test-evolclaw/data/evolclaw.sample.json');
      expect(p.db).toBe('/tmp/test-evolclaw/data/sessions.db');
      expect(p.pid).toBe('/tmp/test-evolclaw/logs/evolclaw.pid');
      expect(p.dataDir).toBe('/tmp/test-evolclaw/data');
      expect(p.logs).toBe('/tmp/test-evolclaw/logs');
      expect(p.lineStats).toBe('/tmp/test-evolclaw/logs/line-stats.log');
    });
  });

  describe('ensureDataDirs', () => {
    const testDir = path.join(os.tmpdir(), `evolclaw-test-${Date.now()}`);

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should create data and logs directories', () => {
      _resetRoot();
      process.env.EVOLCLAW_HOME = testDir;
      ensureDataDirs();
      expect(fs.existsSync(path.join(testDir, 'data'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'logs'))).toBe(true);
    });

    it('should not fail if directories already exist', () => {
      _resetRoot();
      process.env.EVOLCLAW_HOME = testDir;
      ensureDataDirs();
      ensureDataDirs(); // 第二次调用不应报错
      expect(fs.existsSync(path.join(testDir, 'data'))).toBe(true);
    });
  });

  describe('getPackageRoot', () => {
    it('should return the project root directory', () => {
      const root = getPackageRoot();
      // 项目根目录应包含 package.json
      expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    });
  });
});
