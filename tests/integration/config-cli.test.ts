import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/ipc.js', () => ({
  ipcQuery: vi.fn().mockRejectedValue(new Error('daemon offline')),
}));

import { cmdConfig } from '../../src/cli/config.js';
import { _resetRoot } from '../../src/paths.js';
import { _resetSchemaCache } from '../../src/config/schema-registry.js';

const AID = 'bot.agentid.pub';

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-cfgcli-'));
  process.env.EVOLCLAW_HOME = root;
  delete process.env.EVOLCLAW_SESSION_ID;
  _resetRoot();
  _resetSchemaCache();
  // 最小 agent 配置（v3）
  const adir = path.join(root, 'agents', AID);
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, 'config.json'), JSON.stringify({ $schema_version: 2, aid: AID, channels: [] }));
  return root;
}
function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  delete process.env.EVOLCLAW_HOME;
  delete process.env.EVOLCLAW_SESSION_ID;
  _resetRoot();
}

/** 捕获 cmdConfig 的 JSON 输出。 */
async function runJson(args: string[]): Promise<any> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => { throw new Error('exit'); }) as any);
  try {
    await cmdConfig([...args, '--format', 'json']);
  } catch { /* exit thrown */ }
  finally { spy.mockRestore(); exitSpy.mockRestore(); }
  const last = logs[logs.length - 1];
  try { return JSON.parse(last); } catch { return { _raw: last }; }
}

describe('integration: ec config CLI', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('set 字段到 config.json；get 读回', async () => {
    const setRes = await runJson(['set', 'chatmode.private', 'proactive', '--self', AID]);
    if (!setRes.ok) {
      console.log('setRes:', JSON.stringify(setRes, null, 2));
    }
    expect(setRes.ok).toBe(true);
    // v3: 不再区分 H/HA 权限
    expect(setRes.permission).toBe('H');
    // v3: 所有字段都在 config.json
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agents', AID, 'config.json'), 'utf-8'));
    expect(cfg.chatmode.private).toBe('proactive');

    const getRes = await runJson(['get', 'chatmode.private', '--self', AID]);
    expect(getRes.value).toBe('proactive');
  });

  it('set H 字段 → config.json', async () => {
    const setRes = await runJson(['set', 'observable', 'true', '--self', AID]);
    expect(setRes.ok).toBe(true);
    expect(setRes.permission).toBe('H');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agents', AID, 'config.json'), 'utf-8'));
    expect(cfg.observable).toBe(true);
  });

  it('写操作无 selector → 拒绝', async () => {
    const r = await runJson(['set', 'observable', 'true']);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SELECTOR_REQUIRED');
  });

  it('D7：--default + 不支持的字段 → 拒绝', async () => {
    // v3: defaults schema 不支持 chatmode 字段
    const r = await runJson(['set', 'chatmode.private', 'proactive', '--default']);
    expect(r.ok).toBe(false);
    // 错误码：字段不在 defaults schema 中
    expect(r.code).toBe('UNKNOWN_FIELD');
  });

  it('agent 托管环境写 H 字段 → 拒绝', async () => {
    process.env.EVOLCLAW_SESSION_ID = 'sess-1';
    const r = await runJson(['set', 'observable', 'true', '--self', AID]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN_H_WRITE');
  });

  it('agent 托管环境写 H 字段 → 拒绝（包括行为字段）', async () => {
    process.env.EVOLCLAW_SESSION_ID = 'sess-1';
    // v3 当前实现：所有字段都在 agent-config（H），托管环境统一禁止写入
    // TODO: 未来应迁移到字段级权限控制
    const r = await runJson(['set', 'show_activities', 'none', '--self', AID]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN_H_WRITE');
  });

  it('--process 读写 evolclaw.json（链外单 H）', async () => {
    const setRes = await runJson(['set', 'ecweb.port', '8080', '--process']);
    expect(setRes.ok).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'evolclaw.json'), 'utf-8'));
    expect(cfg.ecweb.port).toBe(8080);
  });

  it('fields 列出 agent 作用域字段', async () => {
    const r = await runJson(['fields', '--self', AID]);
    expect(r.ok).toBe(true);
    const schemas = r.fields.map((f: any) => f.schema);
    // v3: 只有 agent-config schema（不再有独立的 behavior schema）
    expect(schemas).toContain('agent-config');
    expect(schemas).not.toContain('behavior');
  });

  it('effective 合并视图', async () => {
    await runJson(['set', 'chatmode.private', 'proactive', '--self', AID]);
    const r = await runJson(['effective', '--self', AID]);
    expect(r.ok).toBe(true);
    expect(r.effective.aid).toBe(AID);
    // v3: 所有字段在顶层（不再有 effective.behavior 子树）
    expect(r.effective.chatmode.private).toBe('proactive');
  });

  it('snapshot → history → restore 周期', async () => {
    await runJson(['set', 'show_activities', 'none', '--self', AID]);
    const snap = await runJson(['snapshot']);
    expect(snap.ok).toBe(true);
    const hist = await runJson(['history']);
    expect(hist.versions.length).toBeGreaterThan(0);
  });
});
