import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _resetRoot, resolvePaths } from '../../src/paths.js';
import {
  snapshot, restore, diffVersions, listAllVersions, readCurrent, prune, collectConfigFiles, incrementSuccessCount,
} from '../../src/core/config/snapshot.js';
import { appendBootLog, readBootLog, selfDiagnose } from '../../src/core/config/boot-log.js';

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-snap-'));
  process.env.EVOLCLAW_HOME = root;
  _resetRoot();
  // 种一个最小配置树
  fs.mkdirSync(path.join(root, 'agents', 'bot.agentid.pub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evolclaw.json'), JSON.stringify({ $schema_version: 1, aid: 'bot.agentid.pub' }));
  fs.writeFileSync(path.join(root, 'agents', 'defaults.json'), JSON.stringify({ $schema_version: 1 }));
  fs.writeFileSync(path.join(root, 'agents', 'bot.agentid.pub', 'config.json'), JSON.stringify({ $schema_version: 1, aid: 'bot.agentid.pub', channels: [] }));
  return root;
}
function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
}

describe('config snapshot/restore', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('collectConfigFiles 收集配置树（不含 .env）', () => {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=x');
    fs.writeFileSync(path.join(root, 'agents', 'bot.agentid.pub', '.env'), 'TOK=y');
    const files = collectConfigFiles(root);
    expect(files).toContain('evolclaw.json');
    expect(files).toContain('agents/defaults.json');
    expect(files).toContain('agents/bot.agentid.pub/config.json');
    expect(files.some(f => f.endsWith('.env'))).toBe(false);
  });

  it('首次 snapshot 建全量 v100，current 指向它', () => {
    const r = snapshot('manual');
    expect(r.created).toBe(true);
    expect(r.type).toBe('full');
    expect(r.version).toBe('v100');
    expect(readCurrent()).toEqual({ full: 'v100', delta: 'v100' });
  });

  it('无变化时不建版本（与 current 比对）', () => {
    snapshot('manual');
    const r2 = snapshot('manual');
    expect(r2.created).toBe(false);
    expect(r2.reason).toBe('no-change');
  });

  it('小改动建增量 v101', () => {
    snapshot('manual');
    fs.writeFileSync(path.join(root, 'agents', 'bot.agentid.pub', 'config.json'),
      JSON.stringify({ $schema_version: 1, aid: 'bot.agentid.pub', channels: [], enabled: false }));
    const r = snapshot('manual');
    expect(r.created).toBe(true);
    expect(r.type).toBe('delta');
    expect(r.version).toBe('v101');
    expect(readCurrent()).toEqual({ full: 'v100', delta: 'v101' });
  });

  it('--full 强制新全量 v200', () => {
    snapshot('manual');
    fs.writeFileSync(path.join(root, 'agents', 'defaults.json'), JSON.stringify({ $schema_version: 1, owners: ['x.agentid.pub'] }));
    const r = snapshot('manual', { full: true });
    expect(r.type).toBe('full');
    expect(r.version).toBe('v200');
  });

  it('restore 回到旧版本，工作目录被覆盖', () => {
    snapshot('manual'); // v100
    const cfgPath = path.join(root, 'agents', 'bot.agentid.pub', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ $schema_version: 1, aid: 'bot.agentid.pub', channels: [], enabled: false }));
    snapshot('manual'); // v101 (enabled:false)
    // restore v100
    const rr = restore('v100');
    expect(rr.ok).toBe(true);
    const restored = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(restored.enabled).toBeUndefined();
    // restore 前会建 pre-restore 快照；current 指向 v100
    expect(readCurrent()?.delta).toBe('v100');
  });

  it('diff 两版本', () => {
    snapshot('manual');
    fs.writeFileSync(path.join(root, 'agents', 'bot.agentid.pub', 'config.json'),
      JSON.stringify({ $schema_version: 1, aid: 'bot.agentid.pub', channels: [], enabled: false }));
    snapshot('manual');
    const d = diffVersions('v100', 'v101');
    expect('error' in d).toBe(false);
    if (!('error' in d)) expect(d.modified).toContain('agents/bot.agentid.pub/config.json');
  });

  it('history 列出版本', () => {
    snapshot('manual');
    const versions = listAllVersions();
    expect(versions.map(v => v.version)).toContain('v100');
  });

  it('prune dry-run 不删，--yes 删', () => {
    snapshot('manual'); // v100 (current)
    // 制造多个全量
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(root, 'agents', 'defaults.json'), JSON.stringify({ $schema_version: 1, owners: [`x${i}.agentid.pub`] }));
      snapshot('manual', { full: true });
    }
    const dry = prune({ keepFull: 1, dryRun: true });
    expect(dry.deleted.length).toBe(0);
    expect(dry.wouldDelete.length).toBeGreaterThan(0);
    // current 指向的版本不会被删
    const cur = readCurrent()!;
    expect(dry.wouldDelete).not.toContain(cur.full);
  });
});

describe('boot-log + self-diagnose', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('appendBootLog / readBootLog 往返', () => {
    appendBootLog({
      bootedAt: '2026-06-14T00:00:00Z', startMethod: 'manual',
      selectedVersion: { full: 'v100', delta: 'v100' }, actualVersion: { full: 'v100', delta: 'v100' },
      fellBack: false, versions: { evolclaw: '3.4.0', node: 'v22' }, platform: 'linux/x64',
    });
    const boots = readBootLog(5);
    expect(boots.length).toBe(1);
    expect(boots[0].startMethod).toBe('manual');
  });

  it('selfDiagnose：current 版本可用时 ok 且不回落', async () => {
    snapshot('manual'); // v100, current, successCount=0 but newest-2 rule applies
    const r = await selfDiagnose(() => true); // probe: always ok
    expect(r.ok).toBe(true);
    expect(r.fellBack).toBe(false);
    expect(r.actualVersion?.delta).toBe('v100');
  });

  it('selfDiagnose：current 版本探测失败 → 回落到上一可用版本', async () => {
    snapshot('manual'); // v100, successCount=0
    // give v100 a successCount so it qualifies for fallback
    incrementSuccessCount('v100');
    fs.writeFileSync(path.join(root, 'agents', 'bot.agentid.pub', 'config.json'),
      JSON.stringify({ $schema_version: 1, aid: 'bot.agentid.pub', channels: [], enabled: false }));
    snapshot('manual'); // v101, current (W has enabled:false)
    // probe: ok only if config doesn't have enabled field (i.e. v100's content)
    const probe = () => {
      try {
        const cfg = JSON.parse(fs.readFileSync(
          path.join(root, 'agents', 'bot.agentid.pub', 'config.json'), 'utf-8'));
        return !Object.prototype.hasOwnProperty.call(cfg, 'enabled');
      } catch { return false; }
    };
    const r = await selfDiagnose(probe);
    expect(r.ok).toBe(true);
    expect(r.fellBack).toBe(true);
    expect(r.actualVersion?.delta).toBe('v100');
    // 回落不改 current.json
    expect(readCurrent()?.delta).toBe('v101');
  });
});
