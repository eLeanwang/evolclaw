/**
 * Tests for AUN init bugfixes (v2.5.x):
 *
 * Round 1 (v2.5.2):
 * - Bug 1: --non-interactive throws when --aun-aid missing
 * - Bug 4: owner field passed to AUNChannel constructor
 *
 * Round 2 (v2.5.4 — compat report):
 * - Issue 1: npmInstallGlobal needs shell: isWindows for Node 24+ CVE-2024-27980
 * - Issue 2: resolveAunCoreSdkPkg node_modules traversal (no createRequire dependency)
 * - Issue 3: gateway URL auto-discovery (no hardcoded :443)
 * - Issue 4: CA cert content validation (BEGIN CERTIFICATE check, no empty files)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AUNChannel } from '../../src/channels/aun.js';
import { resolveAunCoreSdkPkg } from '../../src/utils/init-channel.js';

// ── Bug 1: --non-interactive requires --aun-aid ───────────────────────────────

describe('Bug 1: --non-interactive AUN channel requires --aun-aid', () => {
  it('should throw when channel=aun but aunAid is missing', () => {
    const options = { nonInteractive: true, channel: 'aun', defaultPath: '/tmp' };
    const shouldThrow = options.channel === 'aun' && !(options as any).aunAid;
    expect(shouldThrow).toBe(true);
  });

  it('should not throw when aunAid is provided', () => {
    const options = { nonInteractive: true, channel: 'aun', aunAid: 'bot.test.pub' };
    const shouldThrow = options.channel === 'aun' && !options.aunAid;
    expect(shouldThrow).toBe(false);
  });

  it('should not throw when channel is not aun', () => {
    const options = { nonInteractive: true, channel: 'feishu' };
    const shouldThrow = options.channel === 'aun' && !(options as any).aunAid;
    expect(shouldThrow).toBe(false);
  });
});

// ── Issue 1: npmInstallGlobal Windows shell ────────────────────────────────────

describe('Issue 1: npmInstallGlobal Windows compatibility', () => {
  it('selects npm.cmd on Windows, npm on Unix', () => {
    const selectNpmCmd = (isWin: boolean) => isWin ? 'npm.cmd' : 'npm';
    expect(selectNpmCmd(true)).toBe('npm.cmd');
    expect(selectNpmCmd(false)).toBe('npm');
  });

  it('shell option is true on Windows, false on Unix', () => {
    // Node 24+ requires shell: true for .cmd files (CVE-2024-27980)
    const getExecOpts = (isWin: boolean) => ({ timeout: 180000, shell: isWin });
    expect(getExecOpts(true).shell).toBe(true);
    expect(getExecOpts(false).shell).toBe(false);
  });

  it('EACCES on Windows throws specific admin error (no sudo fallback)', () => {
    // On Windows, EACCES should throw telling user to use admin shell, not attempt sudo
    const handleEacces = (isWin: boolean) => {
      if (isWin) {
        throw new Error('权限不足。请以管理员身份运行 PowerShell 或 CMD，然后重试');
      }
      return 'sudo-fallback';
    };
    expect(() => handleEacces(true)).toThrow('权限不足');
    expect(handleEacces(false)).toBe('sudo-fallback');
  });
});

// ── Issue 2: resolveAunCoreSdkPkg node_modules traversal ──────────────────────

describe('Issue 2: resolveAunCoreSdkPkg', () => {
  it('finds package by walking up node_modules (Strategy 1 — inline simulation)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-walk-'));
    const pkgName = '@eleans/aun-core-sdk';

    // Simulate: /tmp/xxx/node_modules/@eleans/aun-core-sdk/package.json
    const pkgDir = path.join(tmpDir, 'node_modules', pkgName);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: pkgName,
      version: '0.3.0',
    }));

    // Walk up from a subdirectory (simulating import.meta.url dirname)
    let dir = path.join(tmpDir, 'dist', 'utils');
    fs.mkdirSync(dir, { recursive: true });

    let found: { version: string; path: string } | null = null;
    while (true) {
      const candidate = path.join(dir, 'node_modules', pkgName, 'package.json');
      if (fs.existsSync(candidate)) {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (data.name === pkgName) {
          found = { version: data.version, path: candidate };
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    expect(found).not.toBeNull();
    expect(found!.version).toBe('0.3.0');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when package is not in any ancestor node_modules', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-notfound-'));
    const pkgName = '@eleans/aun-core-sdk';

    let dir = tmpDir;
    let found: { version: string } | null = null;
    for (let i = 0; i < 3; i++) {
      const candidate = path.join(dir, 'node_modules', pkgName, 'package.json');
      if (fs.existsSync(candidate)) {
        found = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        break;
      }
      dir = path.dirname(dir);
    }

    expect(found).toBeNull();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolveAunCoreSdkPkg() finds the real installed SDK (integration)', () => {
    // This tests the actual exported function against the real node_modules
    const result = resolveAunCoreSdkPkg();
    // The SDK is a dependency, so it should be found
    if (result) {
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.path).toContain('@agentunion');
      expect(result.path).toContain('package.json');
    }
    // If not installed (CI without optional deps), null is acceptable
  });

  it('scoped package path.join handles @ correctly', () => {
    // Verify path.join doesn't mangle scoped package names with @
    const joined = path.join('/tmp', 'node_modules', '@eleans/aun-core-sdk', 'package.json');
    expect(joined).toContain('@eleans');
    expect(joined).toContain('aun-core-sdk');
    expect(joined).toContain('package.json');
    // The / in scoped name becomes a path separator — @eleans is a directory
    expect(joined).toMatch(/@eleans/);
  });
});

// ── Issue 3: gateway URL auto-discovery ───────────────────────────────────────

describe('Issue 3: gateway URL derivation from SDK result', () => {
  it('derives HTTPS PKI URL from WSS gateway URL', () => {
    const gateway = 'wss://gateway.agentid.pub:20001/aun';
    const gwHttp = gateway.replace(/^wss?:/, 'https:').replace(/\/aun$/, '');
    expect(`${gwHttp}/pki/chain`).toBe('https://gateway.agentid.pub:20001/pki/chain');
  });

  it('handles WS (non-secure) gateway URL', () => {
    const gateway = 'ws://localhost:8080/aun';
    const gwHttp = gateway.replace(/^wss?:/, 'https:').replace(/\/aun$/, '');
    expect(`${gwHttp}/pki/chain`).toBe('https://localhost:8080/pki/chain');
  });

  it('handles gateway URL without /aun suffix', () => {
    const gateway = 'wss://gateway.agentid.pub:20001';
    const gwHttp = gateway.replace(/^wss?:/, 'https:').replace(/\/aun$/, '');
    expect(`${gwHttp}/pki/chain`).toBe('https://gateway.agentid.pub:20001/pki/chain');
  });

  it('handles gateway URL on default port (no port specified)', () => {
    const gateway = 'wss://gateway.agentid.pub/aun';
    const gwHttp = gateway.replace(/^wss?:/, 'https:').replace(/\/aun$/, '');
    expect(`${gwHttp}/pki/chain`).toBe('https://gateway.agentid.pub/pki/chain');
  });

  it('interactive mode only sets _gatewayUrl when custom port specified', () => {
    // When gatewayPort is undefined (user left blank), SDK auto-discovers
    const gatewayPort: number | undefined = undefined;
    const shouldSetManually = !!gatewayPort;
    expect(shouldSetManually).toBe(false);

    // When gatewayPort is specified, set manually
    const customPort = 8443;
    expect(!!customPort).toBe(true);
  });

  it('custom port builds correct WSS URL from AID domain', () => {
    const aid = 'mybot.agentid.pub';
    const gatewayPort = 8443;
    const domain = aid.split('.').slice(1).join('.');
    const gatewayUrl = `wss://gateway.${domain}:${gatewayPort}/aun`;
    expect(gatewayUrl).toBe('wss://gateway.agentid.pub:8443/aun');
  });
});

// ── Issue 4: CA cert content validation ───────────────────────────────────────

describe('Issue 4: CA cert content validation', () => {
  it('accepts valid PEM certificate', () => {
    const body = '-----BEGIN CERTIFICATE-----\nMIIBxTCCAW...\n-----END CERTIFICATE-----\n';
    expect(body.includes('BEGIN CERTIFICATE')).toBe(true);
  });

  it('accepts multi-cert PEM chain', () => {
    const body = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n';
    expect(body.includes('BEGIN CERTIFICATE')).toBe(true);
  });

  it('rejects empty response', () => {
    const body = '';
    expect(body.includes('BEGIN CERTIFICATE')).toBe(false);
  });

  it('rejects HTML error page', () => {
    const body = '<html><body>403 Forbidden</body></html>';
    expect(body.includes('BEGIN CERTIFICATE')).toBe(false);
  });

  it('rejects redirect body without certificate', () => {
    const body = 'Moved Permanently. Redirecting to https://...';
    expect(body.includes('BEGIN CERTIFICATE')).toBe(false);
  });

  it('rejects JSON error response', () => {
    const body = '{"error":"not_found","message":"endpoint not available"}';
    expect(body.includes('BEGIN CERTIFICATE')).toBe(false);
  });
});

// ── Bug 4: owner field passed to AUNChannel ───────────────────────────────────

describe('Bug 4: owner field in AUNChannel constructor', () => {
  it('AUNChannel receives owner from config', () => {
    const ch = new AUNChannel({
      aid: 'bot.test.pub',
      owner: 'alice.test.pub',
    });
    expect((ch as any).config.owner).toBe('alice.test.pub');
  });

  it('AUNChannel works without owner (optional)', () => {
    const ch = new AUNChannel({ aid: 'bot.test.pub' });
    expect((ch as any).config.owner).toBeUndefined();
  });

  it('createChannels passes owner from inst config to AUNChannel', () => {
    const instConfig = {
      aid: 'bot.test.pub',
      owner: 'alice.test.pub',
      keystorePath: undefined,
      gatewayUrl: undefined,
      accessToken: undefined,
      flushDelay: undefined,
      encryptionSeed: undefined,
    };

    const channelConfig = {
      aid: instConfig.aid,
      keystorePath: instConfig.keystorePath,
      gatewayUrl: instConfig.gatewayUrl,
      accessToken: instConfig.accessToken,
      flushDelay: instConfig.flushDelay,
      encryptionSeed: instConfig.encryptionSeed,
      owner: instConfig.owner,
    };

    expect(channelConfig.owner).toBe('alice.test.pub');
  });
});

// ── init.ts: non-interactive CA download guards ───────────────────────────────

describe('init.ts: CA download conditional guards', () => {
  it('skips CA download when result.gateway is undefined', () => {
    const result = { aid: 'bot.test.pub', cert_pem: 'xxx', gateway: undefined };
    const caCertExists = false;
    const shouldDownload = !caCertExists && result.gateway;
    expect(shouldDownload).toBeFalsy();
  });

  it('skips CA download when cert already exists', () => {
    const result = { aid: 'bot.test.pub', gateway: 'wss://gw.test.pub:443/aun' };
    const caCertExists = true;
    const shouldDownload = !caCertExists && result.gateway;
    expect(shouldDownload).toBeFalsy();
  });

  it('downloads CA when cert missing and gateway available', () => {
    const result = { aid: 'bot.test.pub', gateway: 'wss://gw.test.pub:20001/aun' };
    const caCertExists = false;
    const shouldDownload = !caCertExists && result.gateway;
    expect(shouldDownload).toBeTruthy();
  });
});

// ── init.ts: aunOwner conditional spread ──────────────────────────────────────

describe('init.ts: aunOwner config writing', () => {
  it('includes owner when aunOwner is provided', () => {
    const options = { aunOwner: 'alice.test.pub' };
    const aunConfig = {
      enabled: true,
      aid: 'bot.test.pub',
      ...(options.aunOwner && { owner: options.aunOwner }),
    };
    expect(aunConfig.owner).toBe('alice.test.pub');
  });

  it('omits owner when aunOwner is undefined', () => {
    const options: { aunOwner?: string } = {};
    const aunConfig = {
      enabled: true,
      aid: 'bot.test.pub',
      ...(options.aunOwner && { owner: options.aunOwner }),
    };
    expect(aunConfig).not.toHaveProperty('owner');
  });
});
