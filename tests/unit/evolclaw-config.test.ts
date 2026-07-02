import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEvolclawConfig, saveEvolclawConfig } from '../../src/config-store.js';
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

describe('evolclaw-config', () => {
  it('returns empty object when file missing', () => {
    expect(loadEvolclawConfig()).toEqual({});
  });
  it('round-trips aid and tunnel', () => {
    saveEvolclawConfig({ $schema_version: 1, aid: 'ec12345.agentid.pub', tunnel: { targets: [] } });
    const cfg = loadEvolclawConfig();
    expect(cfg.aid).toBe('ec12345.agentid.pub');
    expect(cfg.tunnel?.targets).toEqual([]);
  });
  it('merge-saves without losing existing fields', () => {
    saveEvolclawConfig({ $schema_version: 1, aid: 'ec12345.agentid.pub' });
    saveEvolclawConfig({ ...loadEvolclawConfig(), debug: { logLevel: 'DEBUG' } });
    const cfg = loadEvolclawConfig();
    expect(cfg.aid).toBe('ec12345.agentid.pub');
    expect(cfg.debug?.logLevel).toBe('DEBUG');
  });
  it('round-trips owners array', () => {
    saveEvolclawConfig({ $schema_version: 1, owners: ['op.agentid.pub', 'op2.agentid.pub'] });
    expect(loadEvolclawConfig().owners).toEqual(['op.agentid.pub', 'op2.agentid.pub']);
  });
  it('round-trips watch.logTypes', () => {
    saveEvolclawConfig({ watch: { logTypes: ['evolclaw', 'aun'] } });
    const cfg = loadEvolclawConfig();
    expect(cfg.watch?.logTypes).toEqual(['evolclaw', 'aun']);
  });
});
