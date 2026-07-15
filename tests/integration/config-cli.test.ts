import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ipcMock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/ipc.js', () => ({ ipcQuery: ipcMock.query }));

import { cmdConfig } from '../../src/cli/config.js';
import { _resetRoot } from '../../src/paths.js';
import { _resetSchemaCache } from '../../src/config/schema-registry.js';
import { AGENT_DELEGATION_TOKEN_ENV } from '../../src/core/auth/agent-delegation.js';

const AID = 'bot.agentid.pub';

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-cfgcli-'));
  process.env.EVOLCLAW_HOME = root;
  delete process.env.EVOLCLAW_SESSION_ID;
  delete process.env[AGENT_DELEGATION_TOKEN_ENV];
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
  delete process.env[AGENT_DELEGATION_TOKEN_ENV];
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
  beforeEach(() => {
    root = setupHome();
    ipcMock.query.mockReset().mockRejectedValue(new Error('daemon offline'));
  });
  afterEach(() => cleanup(root));

  it('set 字段到 config.json；get 读回', async () => {
    const setRes = await runJson(['set', 'chatmode.private', 'proactive', '--self', AID]);
    if (!setRes.ok) {
      console.log('setRes:', JSON.stringify(setRes, null, 2));
    }
    expect(setRes.ok).toBe(true);
    // v3: 所有字段都在 config.json
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agents', AID, 'config.json'), 'utf-8'));
    expect(cfg.chatmode.private).toBe('proactive');

    const getRes = await runJson(['get', 'chatmode.private', '--self', AID]);
    expect(getRes.value).toBe('proactive');
  });

  it('set 字段 → config.json', async () => {
    const setRes = await runJson(['set', 'observable', 'true', '--self', AID]);
    expect(setRes.ok).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agents', AID, 'config.json'), 'utf-8'));
    expect(cfg.observable).toBe(true);
  });

  it('写操作无 selector → 拒绝', async () => {
    const r = await runJson(['set', 'observable', 'true']);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SELECTOR_REQUIRED');
  });

  it('D7：--default + 不支持的字段 → 拒绝', async () => {
    const r = await runJson(['set', 'chatmode.private', 'proactive', '--default']);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DEFAULT_BEHAVIOR_REJECT');
  });

  it('agent 托管环境字段操作通过 daemon IPC 执行', async () => {
    process.env.EVOLCLAW_SESSION_ID = 'sess-1';
    process.env[AGENT_DELEGATION_TOKEN_ENV] = 'task-token';
    ipcMock.query.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        subcommand: 'set',
        field: 'show_activities',
        value: 'none',
        scope: 'relation',
        file: 'relation-config',
      },
    });

    const r = await runJson([
      'set', 'show_activities', 'none', '--self', AID, '--peer', 'aun#user1',
    ]);
    expect(r).toMatchObject({ ok: true, field: 'show_activities', scope: 'relation' });
    expect(ipcMock.query).toHaveBeenCalledWith(expect.any(String), {
      type: 'config.op',
      argv: ['config', 'set', 'show_activities', 'none', '--self', AID, '--peer', 'aun#user1', '--format', 'json'],
      sessionId: 'sess-1',
      delegationToken: 'task-token',
    }, 10_000);

    const agentConfig = JSON.parse(fs.readFileSync(path.join(root, 'agents', AID, 'config.json'), 'utf-8'));
    expect(agentConfig.show_activities).toBeUndefined();
  });

  it('agent 托管环境 daemon 不可用时 fail-closed', async () => {
    process.env.EVOLCLAW_SESSION_ID = 'sess-1';
    process.env[AGENT_DELEGATION_TOKEN_ENV] = 'task-token';
    const r = await runJson(['set', 'show_activities', 'none', '--self', AID]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DAEMON_UNAVAILABLE');
  });

  it('agent 托管环境透传 daemon 的授权拒绝', async () => {
    process.env.EVOLCLAW_SESSION_ID = 'sess-1';
    process.env[AGENT_DELEGATION_TOKEN_ENV] = 'task-token';
    ipcMock.query.mockResolvedValue({ ok: false, code: 'NO_PERMISSION', error: 'visitor is read-only' });
    const r = await runJson(['set', 'show_activities', 'none']);
    expect(r).toMatchObject({ ok: false, code: 'NO_PERMISSION', error: 'visitor is read-only' });
  });

  it('agent managed environment sends management commands through IPC', async () => {
    process.env.EVOLCLAW_SESSION_ID = 'sess-1';
    process.env[AGENT_DELEGATION_TOKEN_ENV] = 'task-token';
    ipcMock.query.mockResolvedValue({
      ok: true,
      result: { ok: true, subcommand: 'history', versions: [] },
    });
    const r = await runJson(['history']);
    expect(r).toMatchObject({ ok: true, versions: [] });
    expect(ipcMock.query).toHaveBeenCalledWith(expect.any(String), {
      type: 'config.op',
      argv: ['config', 'history', '--format', 'json'],
      sessionId: 'sess-1',
      delegationToken: 'task-token',
    }, 10_000);
  });

  it('agent managed environment requires a task delegation token', async () => {
    process.env.EVOLCLAW_SESSION_ID = 'sess-1';
    const r = await runJson(['get', 'owners']);
    expect(r).toMatchObject({ ok: false, code: 'DELEGATION_REQUIRED' });
    expect(ipcMock.query).not.toHaveBeenCalled();
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
    expect(r.effective.aid).toEqual({ value: AID, source: 'agent' });
    // v3: 所有字段在顶层（不再有 effective.behavior 子树）
    expect(r.effective.chatmode.value.private).toBe('proactive');
    expect(r.effective.chatmode.source).toBe('agent');
  });

  it('validate is read-only and does not rewrite or touch the config file', async () => {
    const file = path.join(root, 'agents', AID, 'config.json');
    const beforeContent = fs.readFileSync(file, 'utf-8');
    const beforeMtime = fs.statSync(file).mtimeMs;

    const result = await runJson(['validate', '--self', AID]);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(beforeContent);
    expect(fs.statSync(file).mtimeMs).toBe(beforeMtime);
  });

  it('snapshot → history → restore 周期', async () => {
    await runJson(['set', 'show_activities', 'none', '--self', AID]);
    const snap = await runJson(['snapshot']);
    expect(snap.ok).toBe(true);
    const hist = await runJson(['history']);
    expect(hist.versions.length).toBeGreaterThan(0);
  });
});
