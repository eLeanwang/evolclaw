import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializeEckSnapshotsConfig,
  isEckSnapshotsEnabled,
  saveEvolclawConfig,
} from '../../src/config-store.js';
import { ConfigTarget, validateConfig } from '../../src/config/config-manager.js';
import { snapshot } from '../../src/core/message/response-snapshot.js';
import { cleanEckDebug, renderKitSections } from '../../src/eck/kit-renderer.js';
import { renderMessageBody } from '../../src/eck/message-renderer.js';
import { eckDebugDir, getPackageRoot, resolvePaths } from '../../src/paths.js';

const SNAPSHOT_PREFIXES = ['vars-', 'context-', 'fragments-', 'manifest-', 'msg-render-'];
const originalResponseSnapshot = process.env.RESPONSE_SNAPSHOT;

afterEach(() => {
  if (originalResponseSnapshot === undefined) delete process.env.RESPONSE_SNAPSHOT;
  else process.env.RESPONSE_SNAPSHOT = originalResponseSnapshot;
  vi.restoreAllMocks();
});

function configureSnapshots(enabled: boolean): void {
  saveEvolclawConfig({ $schema_version: 1, debug: { eckSnapshots: enabled } });
  initializeEckSnapshotsConfig();
}

function renderVars(): Record<string, unknown> {
  const packageRoot = getPackageRoot();
  return {
    KITS_RULES: path.join(packageRoot, 'kits', 'rules'),
    KITS_FRAGMENTS: path.join(packageRoot, 'kits', 'templates', 'system-fragments'),
    KITS_MESSAGE_FRAGMENTS: path.join(packageRoot, 'kits', 'templates', 'message-fragments'),
    KITS_DOCS: path.join(packageRoot, 'kits', 'docs'),
    PERSONAL_DIR: path.join(resolvePaths().root, 'agents', 'test', 'personal'),
    RELATIONS_DIR: path.join(resolvePaths().root, 'agents', 'test', 'relations'),
    chatType: 'private',
    lifecycle: 'active',
    selfAid: 'test.agentid.pub',
    peerId: 'peer.agentid.pub',
    peerKey: 'test#peer',
    timezone: 'UTC',
  };
}

async function waitForSnapshotPrefixes(dir: string): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const files = fs.readdirSync(dir);
    if (SNAPSHOT_PREFIXES.every(prefix => files.some(file => file.startsWith(prefix)))) return files;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return fs.readdirSync(dir);
}

describe('ECK snapshot debug switch', () => {
  it('defaults to disabled and parses explicit boolean values', () => {
    expect(initializeEckSnapshotsConfig()).toBe(false);

    configureSnapshots(true);
    expect(isEckSnapshotsEnabled()).toBe(true);

    configureSnapshots(false);
    expect(isEckSnapshotsEnabled()).toBe(false);
  });

  it('rejects non-boolean and non-process configurations', () => {
    const typeErrors = validateConfig(ConfigTarget.Process, {
      $schema_version: 1,
      debug: { eckSnapshots: 'true' },
    });
    expect(typeErrors.some(error => error.includes('boolean'))).toBe(true);

    const scopedValues: Array<[ConfigTarget, Record<string, unknown>]> = [
      [ConfigTarget.Defaults, { $schema_version: 1, debug: { eckSnapshots: true } }],
      [ConfigTarget.Agent, { $schema_version: 3, aid: 'test.agentid.pub', channels: [], debug: { eckSnapshots: true } }],
      [ConfigTarget.Relation, { $schema_version: 2, debug: { eckSnapshots: true } }],
    ];
    for (const [target, value] of scopedValues) {
      expect(validateConfig(target, value)).toContain('/debug/eckSnapshots is only allowed in process config');
    }
  });

  it('reuses the initialized value instead of rereading the config', () => {
    configureSnapshots(true);
    fs.writeFileSync(resolvePaths().evolclawJson, JSON.stringify({
      $schema_version: 1,
      debug: { eckSnapshots: false },
    }));

    expect(isEckSnapshotsEnabled()).toBe(true);
    expect(initializeEckSnapshotsConfig()).toBe(false);
  });

  it('writes all ECK snapshot types when enabled', async () => {
    configureSnapshots(true);
    const dir = eckDebugDir();
    const vars = renderVars();

    const context = renderKitSections({ vars, sessionId: 'kit-session' });
    const message = renderMessageBody(
      [{ peerId: 'peer.agentid.pub', content: 'hello', timestamp: 1_700_000_000_000 }],
      vars,
      'message-session',
    );

    expect(context).toContain('<system-reminder>');
    expect(message.body).toContain('hello');
    const files = await waitForSnapshotPrefixes(dir);
    for (const prefix of SNAPSHOT_PREFIXES) {
      expect(files.some(file => file.startsWith(prefix))).toBe(true);
    }
  });

  it('keeps kit and message rendering byte-identical across switch states', async () => {
    const dir = eckDebugDir();
    const vars = renderVars();

    configureSnapshots(false);
    const disabledContext = renderKitSections({ vars, sessionId: 'kit-session' });
    const disabledMessage = renderMessageBody(
      [{ peerId: 'peer.agentid.pub', content: 'hello', timestamp: 1_700_000_000_000 }],
      vars,
      'message-session',
    );
    expect(fs.existsSync(dir)).toBe(false);

    configureSnapshots(true);
    const enabledContext = renderKitSections({ vars, sessionId: 'kit-session' });
    const enabledMessage = renderMessageBody(
      [{ peerId: 'peer.agentid.pub', content: 'hello', timestamp: 1_700_000_000_000 }],
      vars,
      'message-session',
    );

    expect(enabledContext).toBe(disabledContext);
    expect(enabledMessage).toEqual(disabledMessage);
    await waitForSnapshotPrefixes(dir);
  });

  it('does not touch the debug directory on the disabled hot path', () => {
    configureSnapshots(false);
    const dir = eckDebugDir();
    const vars = renderVars();
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    const write = vi.spyOn(fs, 'writeFile');
    const readDir = vi.spyOn(fs, 'readdirSync');
    const stat = vi.spyOn(fs, 'statSync');

    renderKitSections({ vars, sessionId: 'kit-session' });
    renderMessageBody(
      [{ peerId: 'peer.agentid.pub', content: 'hello', timestamp: 1_700_000_000_000 }],
      vars,
      'message-session',
    );
    cleanEckDebug();

    const touchesDebugDir = (value: unknown): boolean => {
      const file = String(value);
      return file === dir || file.startsWith(`${dir}${path.sep}`);
    };
    for (const spy of [mkdir, write, readDir, stat]) {
      expect(spy.mock.calls.some(call => touchesDebugDir(call[0]))).toBe(false);
    }
  });

  it('requires both the process gate and RESPONSE_SNAPSHOT for response snapshots', () => {
    const output = path.join(eckDebugDir(), 'response-snapshots.jsonl');
    process.env.RESPONSE_SNAPSHOT = '1';
    configureSnapshots(false);
    snapshot.begin('session-disabled', 'task-disabled', 'plugin');
    snapshot.end('session-disabled', 'task-disabled');
    expect(fs.existsSync(output)).toBe(false);

    configureSnapshots(true);
    process.env.RESPONSE_SNAPSHOT = '0';
    snapshot.begin('session-env-off', 'task-env-off', 'plugin');
    snapshot.end('session-env-off', 'task-env-off');
    expect(fs.existsSync(output)).toBe(false);

    process.env.RESPONSE_SNAPSHOT = '1';
    snapshot.begin('session-enabled', 'task-enabled', 'plugin');
    snapshot.set('session-enabled', 'task-enabled', { chatMode: 'interactive' });
    snapshot.end('session-enabled', 'task-enabled');
    expect(fs.existsSync(output)).toBe(true);
    expect(fs.readFileSync(output, 'utf-8')).toContain('"taskId":"task-enabled"');
  });

  it('does not delete existing snapshots while disabled', () => {
    configureSnapshots(false);
    const dir = eckDebugDir();
    fs.mkdirSync(dir, { recursive: true });
    const existing = path.join(dir, 'vars-existing.json');
    fs.writeFileSync(existing, '{}');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(existing, old, old);

    cleanEckDebug();

    expect(fs.existsSync(existing)).toBe(true);
  });

  it('retains the existing 24-hour cleanup when enabled', () => {
    configureSnapshots(true);
    const dir = eckDebugDir();
    fs.mkdirSync(dir, { recursive: true });
    const expired = path.join(dir, 'vars-expired.json');
    const recent = path.join(dir, 'vars-recent.json');
    fs.writeFileSync(expired, '{}');
    fs.writeFileSync(recent, '{}');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(expired, old, old);

    cleanEckDebug();

    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('keeps rendering and response processing successful when the debug path is unusable', () => {
    configureSnapshots(true);
    const dir = eckDebugDir();
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a directory');
    const vars = renderVars();

    expect(() => renderKitSections({ vars, sessionId: 'kit-session' })).not.toThrow();
    expect(() => renderMessageBody(
      [{ peerId: 'peer.agentid.pub', content: 'hello', timestamp: 1_700_000_000_000 }],
      vars,
      'message-session',
    )).not.toThrow();

    process.env.RESPONSE_SNAPSHOT = '1';
    expect(() => {
      snapshot.begin('session-failure', 'task-failure', 'plugin');
      snapshot.end('session-failure', 'task-failure');
    }).not.toThrow();
  });
});
