import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { isEckSnapshotsEnabled, saveEvolclawConfig } from '../../src/config-store.js';
import { cleanEckDebug, renderKitSections } from '../../src/eck/kit-renderer.js';
import { renderMessageBody } from '../../src/eck/message-renderer.js';
import { eckDebugDir, getPackageRoot, resolvePaths } from '../../src/paths.js';

const SNAPSHOT_PREFIXES = ['vars-', 'context-', 'fragments-', 'manifest-', 'msg-render-'];

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
  it('defaults to enabled for upgrade compatibility', () => {
    expect(isEckSnapshotsEnabled()).toBe(true);
  });

  it('writes all ECK snapshot types when enabled', async () => {
    const dir = eckDebugDir();
    fs.mkdirSync(dir, { recursive: true });
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

  it('renders normally without writing snapshots when disabled', () => {
    saveEvolclawConfig({ $schema_version: 1, debug: { eckSnapshots: false } });
    const dir = eckDebugDir();
    fs.mkdirSync(dir, { recursive: true });
    const vars = renderVars();

    const context = renderKitSections({ vars, sessionId: 'kit-session' });
    const message = renderMessageBody(
      [{ peerId: 'peer.agentid.pub', content: 'hello', timestamp: 1_700_000_000_000 }],
      vars,
      'message-session',
    );

    expect(isEckSnapshotsEnabled()).toBe(false);
    expect(context).toContain('<system-reminder>');
    expect(message.body).toContain('hello');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not delete existing snapshots while disabled', () => {
    saveEvolclawConfig({ $schema_version: 1, debug: { eckSnapshots: false } });
    const dir = eckDebugDir();
    fs.mkdirSync(dir, { recursive: true });
    const existing = path.join(dir, 'vars-existing.json');
    fs.writeFileSync(existing, '{}');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(existing, old, old);

    cleanEckDebug();

    expect(fs.existsSync(existing)).toBe(true);
  });
});
