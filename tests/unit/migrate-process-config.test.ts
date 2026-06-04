import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEvolclawConfig } from '../../src/evolclaw-config.js';
import { migrateProcessConfigIfNeeded } from '../../src/config-store.js';
import { _resetRoot } from '../../src/paths.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evc-'));
  process.env.EVOLCLAW_HOME = tmp;
  _resetRoot();
});
afterEach(() => {
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migrateProcessConfigIfNeeded', () => {
  it('moves aun.encryptionSeed into evolclaw.json verbatim (null stays null)', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'),
      JSON.stringify({ $schema_version: 1, aun: { encryptionSeed: null } }));
    migrateProcessConfigIfNeeded();
    const cfg = loadEvolclawConfig();
    // null 原样保留（hasOwnProperty 为真且值为 null）
    expect(cfg.aun).toBeDefined();
    expect(cfg.aun!.encryptionSeed).toBeNull();
    // 旧文件已归档（不再存在于原路径）
    expect(fs.existsSync(path.join(tmp, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'config.json.migrated'))).toBe(true);
  });

  it('moves a real seed string verbatim', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'),
      JSON.stringify({ $schema_version: 1, aun: { encryptionSeed: 'secret-seed' }, log: { level: 'DEBUG' } }));
    migrateProcessConfigIfNeeded();
    const cfg = loadEvolclawConfig();
    expect(cfg.aun!.encryptionSeed).toBe('secret-seed');
    // log 块（死字段）不迁移
    expect((cfg as any).log).toBeUndefined();
  });

  it('no-op when config.json absent', () => {
    migrateProcessConfigIfNeeded();
    expect(loadEvolclawConfig()).toEqual({});
  });

  it('does not clobber existing evolclaw.json fields', () => {
    fs.writeFileSync(path.join(tmp, 'evolclaw.json'),
      JSON.stringify({ $schema_version: 1, aid: 'ec12345.agentid.pub' }));
    fs.writeFileSync(path.join(tmp, 'config.json'),
      JSON.stringify({ aun: { encryptionSeed: 's' } }));
    migrateProcessConfigIfNeeded();
    const cfg = loadEvolclawConfig();
    expect(cfg.aid).toBe('ec12345.agentid.pub'); // 保留
    expect(cfg.aun!.encryptionSeed).toBe('s');   // 合并
  });
});
