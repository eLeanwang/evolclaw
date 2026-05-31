import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Mock @agentunion/fastaun (0.4.3: AIDStore / AID / AUNClient) ─────────────
//
// Flow mapping:
//   aidCreate    → store.register → GatewayDiscovery.discover → store.load → new AUNClient(aid) → client.authenticate
//   agentmdGet   → store.fetchAgentMd
//   agentmdPut   → store.load → new AUNClient(aid) → client.authenticate → client.publishAgentMd → client.close
//   agentmdSync  → store.checkAgentMd → (maybe) store.fetchAgentMd
const {
  mockStoreRegister,
  mockStoreLoad,
  mockFetchAgentMd,
  mockCheckAgentMd,
  mockStoreClose,
  mockSignAgentMd,
  mockVerifyAgentMd,
  mockAuthenticate,
  mockPublishAgentMd,
  mockClientConnect,
  mockClientClose,
} = vi.hoisted(() => ({
  // AIDStore.register — real SDK creates the AID directory.
  mockStoreRegister: vi.fn().mockImplementation(async (aid: string) => {
    const aidDir = path.join(os.homedir(), '.aun', 'AIDs', aid);
    fs.mkdirSync(aidDir, { recursive: true });
    return { ok: true, data: { registered: true } };
  }),
  mockSignAgentMd: vi.fn().mockReturnValue({ ok: true, data: { signed: '---signed-probe---' } }),
  mockVerifyAgentMd: vi.fn().mockReturnValue({ ok: true, data: { status: 'verified', payload: '' } }),
  mockStoreLoad: vi.fn(),
  // AIDStore.fetchAgentMd — Promise<Result<{ aid, content, verification, cert_pem, etag, last_modified }>>.
  mockFetchAgentMd: vi.fn().mockResolvedValue({
    ok: true,
    data: { aid: 'remote.agentid.pub', content: '---\naid: "remote.agentid.pub"\n---', verification: { status: 'verified' }, cert_pem: '', etag: '"abc"', last_modified: '' },
  }),
  // AIDStore.checkAgentMd — Promise<Result<{ ..., needs_update, local_found, remote_found }>>.
  mockCheckAgentMd: vi.fn().mockResolvedValue({
    ok: true,
    data: { aid: 'remote.agentid.pub', local_found: true, remote_found: true, local_etag: '"abc"', remote_etag: '"abc"', needs_update: false, ttl_days: 30 },
  }),
  mockStoreClose: vi.fn(),
  mockAuthenticate: vi.fn().mockResolvedValue({ access_token: 'mock-token', gateway: 'wss://gw.example.com/aun' }),
  mockPublishAgentMd: vi.fn().mockResolvedValue({ aid: 'test.aid', etag: '"abc123"' }),
  mockClientConnect: vi.fn().mockResolvedValue(undefined),
  mockClientClose: vi.fn().mockResolvedValue(undefined),
}));

const makeMockAid = (aid: string) => ({
  aid,
  aunPath: '',
  certPem: 'mock-cert',
  publicKey: 'mock-pub',
  certNotAfter: '2099-01-01T00:00:00Z',
  certIssuer: 'mock-issuer',
  certFingerprint: 'mock-fp',
  deviceId: 'mock-device',
  slotId: 'evolclaw cli',
  isCertValid: () => true,
  isPrivateKeyValid: () => true,
  signAgentMd: mockSignAgentMd,
  verifyAgentMd: mockVerifyAgentMd,
  sign: vi.fn().mockReturnValue({ ok: true, data: { signature: 'sig' } }),
  verify: vi.fn().mockReturnValue({ ok: true, data: { valid: true } }),
});
mockStoreLoad.mockImplementation((aid: string) => ({ ok: true, data: { aid: makeMockAid(aid) } }));

vi.mock('@agentunion/fastaun', () => ({
  AIDStore: class MockAIDStore {
    constructor(_opts: unknown) {}
    register = mockStoreRegister;
    load = mockStoreLoad;
    fetchAgentMd = mockFetchAgentMd;
    checkAgentMd = mockCheckAgentMd;
    close = mockStoreClose;
  },
  AID: class MockAID {
    constructor(aid?: string) { Object.assign(this, makeMockAid(aid ?? '')); }
  },
  AUNClient: class MockAUNClient {
    aid: unknown;
    constructor(aid: unknown) { this.aid = aid; }
    connect = mockClientConnect;
    authenticate = mockAuthenticate;
    publishAgentMd = mockPublishAgentMd;
    call = vi.fn();
    on = vi.fn();
    close = mockClientClose;
  },
  FileSecretStore: class {},
  GatewayDiscovery: class { discover() { return ''; } },
  E2EEError: class E2EEError extends Error {},
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('aun-ops', () => {
  let tmpDir: string;
  let originalHomedir: () => string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aun-ops-test-'));
    originalHomedir = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.aun', 'AIDs'), { recursive: true });
    process.env.EVOLCLAW_HOME = tmpDir;
    const { _resetRoot } = await import('../../src/paths.js');
    _resetRoot();

    mockStoreRegister.mockClear();
    mockStoreLoad.mockClear();
    mockAuthenticate.mockClear();
    mockPublishAgentMd.mockClear();
    mockFetchAgentMd.mockClear();
    mockCheckAgentMd.mockClear();
    mockStoreClose.mockClear();
    mockClientConnect.mockClear();
    mockClientClose.mockClear();
    mockSignAgentMd.mockClear();
    mockVerifyAgentMd.mockClear();
  });

  afterEach(async () => {
    vi.spyOn(os, 'homedir').mockRestore();
    os.homedir = originalHomedir;
    vi.restoreAllMocks();
    delete process.env.EVOLCLAW_HOME;
    const { _resetRoot } = await import('../../src/paths.js');
    _resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('aidCreate — client leak prevention', () => {
    it('closes store when register throws', async () => {
      mockStoreRegister.mockRejectedValueOnce(new Error('network error'));
      const { aidCreate } = await import('../../src/aun/aid/index.js');

      await expect(aidCreate('fail.agentid.pub')).rejects.toThrow('network error');
      // register runs before the client exists, so aidCreate cleans up the store.
      expect(mockStoreClose).toHaveBeenCalled();
    });

    it('returns client on success (caller responsible for closing)', async () => {
      const { aidCreate } = await import('../../src/aun/aid/index.js');

      const result = await aidCreate('ok.agentid.pub');

      expect(result.client).toBeDefined();
      expect(result.alreadyExisted).toBe(false);
      // Client NOT closed by aidCreate — caller's responsibility
    });
  });

  describe('agentmdGet — local vs remote', () => {
    it('returns local file for self AID (has private key)', async () => {
      const aid = 'self.agentid.pub';
      const aidDir = path.join(tmpDir, 'AIDs', aid);
      fs.mkdirSync(path.join(aidDir, 'private'), { recursive: true });
      fs.writeFileSync(path.join(aidDir, 'agent.md'), 'local-content', 'utf-8');

      const { agentmdGet } = await import('../../src/aun/aid/index.js');
      const { _resetRoot } = await import('../../src/paths.js');
      _resetRoot();
      const result = await agentmdGet(aid);

      // SDK 0.3.3: always tries fetchAgentMd first (network-first)
      expect(mockFetchAgentMd).toHaveBeenCalledWith(aid);
      expect(result).toBe('---\naid: "remote.agentid.pub"\n---'); // mock returns this
    });

    it('returns local file regardless of private key presence', async () => {
      const aid = 'remote.agentid.pub';
      const aidDir = path.join(tmpDir, 'AIDs', aid);
      fs.mkdirSync(aidDir, { recursive: true });
      fs.writeFileSync(path.join(aidDir, 'agent.md'), 'stale-local', 'utf-8');

      const { agentmdGet } = await import('../../src/aun/aid/index.js');
      const { _resetRoot } = await import('../../src/paths.js');
      _resetRoot();
      const result = await agentmdGet(aid);

      // SDK 0.3.3: network-first, falls back to local only on network error
      expect(mockFetchAgentMd).toHaveBeenCalledWith(aid);
    });

    it('downloads from network when no local file exists', async () => {
      const { agentmdGet } = await import('../../src/aun/aid/index.js');
      const result = await agentmdGet('unknown.agentid.pub');

      expect(mockFetchAgentMd).toHaveBeenCalledWith('unknown.agentid.pub');
    });
  });

  describe('agentmdPut — upload + local sync', () => {
    it('uploads content and writes local file', async () => {
      const aid = 'bot.agentid.pub';
      const content = '---\naid: "bot.agentid.pub"\n---';

      const { agentmdPut } = await import('../../src/aun/aid/index.js');
      await agentmdPut(content, { aid });

      expect(mockPublishAgentMd).toHaveBeenCalled();
      const localPath = path.join(tmpDir, 'AIDs', aid, 'agent.md');
      expect(fs.existsSync(localPath)).toBe(true);
      expect(fs.readFileSync(localPath, 'utf-8')).toBe(content);
    });

    it('does not write local file if upload fails', async () => {
      mockPublishAgentMd.mockRejectedValueOnce(new Error('upload failed'));
      const aid = 'fail.agentid.pub';

      const { agentmdPut } = await import('../../src/aun/aid/index.js');
      await expect(agentmdPut('content', { aid })).rejects.toThrow('upload failed');

      const localPath = path.join(tmpDir, 'AIDs', aid, 'agent.md');
      expect(fs.existsSync(localPath)).toBe(false);
    });
  });

  describe('buildInitialAgentMd', () => {
    it('generates correct frontmatter', async () => {
      const { buildInitialAgentMd } = await import('../../src/aun/aid/index.js');

      const content = buildInitialAgentMd({ aid: 'mybot.agentid.pub', type: 'ai' });

      expect(content).toContain('aid: "mybot.agentid.pub"');
      expect(content).toContain('name: "mybot"');
      expect(content).toContain('type: "ai"');
      expect(content).toContain('version:');
    });

    it('defaults type to ai', async () => {
      const { buildInitialAgentMd } = await import('../../src/aun/aid/index.js');

      const content = buildInitialAgentMd({ aid: 'x.y.z' });

      expect(content).toContain('type: "ai"');
    });

    it('supports human type', async () => {
      const { buildInitialAgentMd } = await import('../../src/aun/aid/index.js');

      const content = buildInitialAgentMd({ aid: 'alice.agentid.pub', type: 'human' });

      expect(content).toContain('type: "human"');
    });
  });

  describe('aidList', () => {
    it('returns empty array when no AIDs exist', async () => {
      const { aidList } = await import('../../src/aun/aid/index.js');

      const result = aidList();

      expect(result).toEqual([]);
    });

    it('lists AIDs with correct flags', async () => {
      const aidsDir = path.join(tmpDir, 'AIDs');
      // AID with private key + agent.md
      fs.mkdirSync(path.join(aidsDir, 'full.agentid.pub', 'private'), { recursive: true });
      fs.writeFileSync(path.join(aidsDir, 'full.agentid.pub', 'agent.md'), 'content', 'utf-8');

      // AID with only private key (no agent.md)
      fs.mkdirSync(path.join(aidsDir, 'nomd.agentid.pub', 'private'), { recursive: true });

      // AID with only agent.md (no private key)
      fs.mkdirSync(path.join(aidsDir, 'nokey.agentid.pub'), { recursive: true });
      fs.writeFileSync(path.join(aidsDir, 'nokey.agentid.pub', 'agent.md'), 'content', 'utf-8');

      const { aidList } = await import('../../src/aun/aid/index.js');
      const result = aidList();

      expect(result).toHaveLength(3);

      const full = result.find(a => a.aid === 'full.agentid.pub');
      expect(full?.hasPrivateKey).toBe(true);
      expect(full?.hasAgentMd).toBe(true);

      const nomd = result.find(a => a.aid === 'nomd.agentid.pub');
      expect(nomd?.hasPrivateKey).toBe(true);
      expect(nomd?.hasAgentMd).toBe(false);

      const nokey = result.find(a => a.aid === 'nokey.agentid.pub');
      expect(nokey?.hasPrivateKey).toBe(false);
      expect(nokey?.hasAgentMd).toBe(true);
    });
  });

});
