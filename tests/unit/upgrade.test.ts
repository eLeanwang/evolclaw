import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compareVersions } from '../../src/utils/npm-ops.js';

// Mock child_process (still needed for npmInstallGlobal in tryUpgrade) and paths
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../src/paths.js', () => ({
  getPackageRoot: vi.fn(),
}));

// Import after mocks are set up
import { execFile } from 'child_process';
import { getPackageRoot } from '../../src/paths.js';
import { isLinkedInstall, getLocalVersion, checkLatestVersion, tryUpgrade } from '../../src/utils/npm-ops.js';
import fs from 'fs';

const mockedExecFile = vi.mocked(execFile);
const mockedGetPackageRoot = vi.mocked(getPackageRoot);

// ─── compareVersions ────────────────────────────────────────────

describe('compareVersions', () => {
  it('should return 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.6.0', '2.6.0')).toBe(0);
  });

  it('should return -1 when a < b', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('2.5.0', '2.6.0')).toBe(-1);
    expect(compareVersions('2.6.0', '2.6.1')).toBe(-1);
  });

  it('should return 1 when a > b', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    expect(compareVersions('2.6.0', '2.5.0')).toBe(1);
    expect(compareVersions('2.6.1', '2.6.0')).toBe(1);
  });

  it('should handle different segment lengths', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
  });

  it('should handle major version differences', () => {
    expect(compareVersions('3.0.0', '2.99.99')).toBe(1);
    expect(compareVersions('1.99.99', '2.0.0')).toBe(-1);
  });

  it('should strip pre-release tags before comparison', () => {
    expect(compareVersions('2.6.0-beta.1', '2.6.0')).toBe(0);
    expect(compareVersions('2.6.0', '2.6.0-rc.1')).toBe(0);
    expect(compareVersions('2.5.0-beta.1', '2.6.0')).toBe(-1);
    expect(compareVersions('2.7.0-alpha', '2.6.0')).toBe(1);
  });

  it('should handle both sides having pre-release tags', () => {
    expect(compareVersions('2.6.0-beta.1', '2.6.0-rc.2')).toBe(0);
    expect(compareVersions('2.5.0-beta.1', '2.6.0-alpha.1')).toBe(-1);
  });
});

// ─── isLinkedInstall ────────────────────────────────────────────

describe('isLinkedInstall', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should return true when parent dir is not node_modules (dev mode)', () => {
    mockedGetPackageRoot.mockReturnValue('/home/evolclaw');
    expect(isLinkedInstall()).toBe(true);
  });

  it('should return false when parent dir is node_modules (global install)', () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    expect(isLinkedInstall()).toBe(false);
  });

  it('should return false for npm global prefix on macOS', () => {
    mockedGetPackageRoot.mockReturnValue('/usr/local/lib/node_modules/evolclaw');
    expect(isLinkedInstall()).toBe(false);
  });

  it('should return false for nvm-managed global install', () => {
    mockedGetPackageRoot.mockReturnValue('/home/user/.nvm/versions/node/v22.0.0/lib/node_modules/evolclaw');
    expect(isLinkedInstall()).toBe(false);
  });

  it('should return true when path merely contains node_modules in a dir name', () => {
    // e.g. /projects/my_node_modules_backup/evolclaw — parent is NOT 'node_modules'
    mockedGetPackageRoot.mockReturnValue('/projects/my_node_modules_backup/evolclaw');
    expect(isLinkedInstall()).toBe(true);
  });
});

// ─── getLocalVersion ────────────────────────────────────────────

describe('getLocalVersion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should read version from package.json at package root', () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ name: 'evolclaw', version: '2.6.0' }));

    expect(getLocalVersion()).toBe('2.6.0');
  });

  it('should throw if package.json is missing', () => {
    mockedGetPackageRoot.mockReturnValue('/nonexistent');
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });

    expect(() => getLocalVersion()).toThrow('ENOENT');
  });
});

// ─── checkLatestVersion ─────────────────────────────────────────

describe('checkLatestVersion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should return version string on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.7.0' }),
    } as Response);

    const ver = await checkLatestVersion();
    expect(ver).toBe('2.7.0');
  });

  it('should return null on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    const ver = await checkLatestVersion();
    expect(ver).toBeNull();
  });

  it('should return null on empty stdout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const ver = await checkLatestVersion();
    expect(ver).toBeNull();
  });

  it('should trim whitespace from version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '3.0.0' }),
    } as Response);

    const ver = await checkLatestVersion();
    expect(ver).toBe('3.0.0');
  });
});

// ─── tryUpgrade ─────────────────────────────────────────────────

describe('tryUpgrade', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should skip when in linked/dev mode', async () => {
    mockedGetPackageRoot.mockReturnValue('/home/evolclaw');

    const result = await tryUpgrade();
    expect(result.status).toBe('skipped');
  });

  it('should skip when registry check fails', async () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '2.6.0' }));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    const result = await tryUpgrade();
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('Failed to check remote version');
  });

  it('should return no-update when local >= remote', async () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '2.6.0' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.6.0' }),
    } as Response);

    const result = await tryUpgrade();
    expect(result.status).toBe('no-update');
    expect(result.from).toBe('2.6.0');
  });

  it('should return no-update when local > remote', async () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '3.0.0' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.6.0' }),
    } as Response);

    const result = await tryUpgrade();
    expect(result.status).toBe('no-update');
  });

  it('should return upgraded on successful install', async () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '2.6.0' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.7.0' }),
    } as Response);

    mockedExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });

    const result = await tryUpgrade();
    expect(result.status).toBe('upgraded');
    expect(result.from).toBe('2.6.0');
    expect(result.to).toBe('2.7.0');
  });

  it('should retry once and succeed on second attempt', async () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '2.6.0' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.7.0' }),
    } as Response);

    let installAttempt = 0;
    mockedExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      installAttempt++;
      if (installAttempt === 1) {
        cb(new Error('ENETUNREACH'), '', 'network unreachable');
      } else {
        cb(null, '', '');
      }
      return {} as any;
    });

    const result = await tryUpgrade();
    expect(result.status).toBe('upgraded');
    expect(installAttempt).toBe(2);
  });

  it('should return failed after two install failures', async () => {
    mockedGetPackageRoot.mockReturnValue('/usr/lib/node_modules/evolclaw');
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ version: '2.6.0' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ version: '2.7.0' }),
    } as Response);

    let installAttempt = 0;
    mockedExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      installAttempt++;
      cb(new Error('ENETUNREACH'), '', 'network unreachable');
      return {} as any;
    });

    const result = await tryUpgrade();
    expect(result.status).toBe('failed');
    expect(result.from).toBe('2.6.0');
    expect(result.to).toBe('2.7.0');
    expect(result.error).toBe('ENETUNREACH');
    expect(installAttempt).toBe(2);
  });
});
