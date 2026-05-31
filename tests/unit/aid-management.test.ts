import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── isValidAid ────────────────────────────────────────────────────────────────

describe('isValidAid', () => {
  let isValidAid: (name: string) => boolean;

  beforeEach(async () => {
    ({ isValidAid } = await import('../../src/aun/aid/index.js'));
  });

  it('accepts valid 3-label AID', () => {
    expect(isValidAid('agent.example.pub')).toBe(true);
  });

  it('accepts AID with hyphens inside labels', () => {
    expect(isValidAid('my-agent.example-domain.pub')).toBe(true);
  });

  it('accepts AID with digits', () => {
    expect(isValidAid('agent01.example2.pub')).toBe(true);
  });

  it('accepts AID with more than 3 labels', () => {
    expect(isValidAid('a.b.c.d')).toBe(true);
  });

  it('rejects AID with only 2 labels', () => {
    expect(isValidAid('agent.pub')).toBe(false);
  });

  it('rejects AID with 1 label', () => {
    expect(isValidAid('agent')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidAid('')).toBe(false);
  });

  it('rejects label starting with hyphen', () => {
    expect(isValidAid('-agent.example.pub')).toBe(false);
  });

  it('rejects label ending with hyphen', () => {
    expect(isValidAid('agent-.example.pub')).toBe(false);
  });

  it('rejects label with special characters', () => {
    expect(isValidAid('agent@.example.pub')).toBe(false);
    expect(isValidAid('agent.exam ple.pub')).toBe(false);
    expect(isValidAid('agent.example!.pub')).toBe(false);
  });

  it('rejects label with underscore', () => {
    expect(isValidAid('my_agent.example.pub')).toBe(false);
  });

  it('rejects empty label (consecutive dots)', () => {
    expect(isValidAid('agent..pub')).toBe(false);
  });

  it('rejects trailing dot', () => {
    expect(isValidAid('agent.example.pub.')).toBe(false);
  });
});

// ── aidCreate ────────────────────────────────────────────────────────────────

// Mock @agentunion/fastaun (fastaun 0.4.3: AIDStore / AID / AUNClient three-actor model).
//
// Flow mapping:
//   aidCreate (new)      → store.register → GatewayDiscovery.discover → store.load → new AUNClient(aid) → client.authenticate
//   aidCreate (existing) → verifySignAbility (store.load → aid.signAgentMd → aid.verifyAgentMd) → loadClient → client.authenticate
//   agentmdPut           → store.load → new AUNClient(aid) → client.authenticate → client.publishAgentMd → client.close
//
// vi.hoisted so the mocks exist before the hoisted vi.mock factory runs.
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
  // AIDStore.register — real SDK creates the AID directory on registration.
  mockStoreRegister: vi.fn().mockImplementation(async (aid: string) => {
    const aidDir = path.join(os.homedir(), '.aun', 'AIDs', aid);
    fs.mkdirSync(aidDir, { recursive: true });
    return { ok: true, data: { registered: true } };
  }),
  // AID value-object methods (sync, return Result).
  mockSignAgentMd: vi.fn().mockReturnValue({ ok: true, data: { signed: '---signed-probe---' } }),
  mockVerifyAgentMd: vi.fn().mockReturnValue({ ok: true, data: { status: 'verified', payload: '' } }),
  // AIDStore.load — sync, returns Result<{ aid: AID }>.
  mockStoreLoad: vi.fn(),
  mockFetchAgentMd: vi.fn().mockResolvedValue({
    ok: true,
    data: { aid: 'test.aid', content: '---\naid: "remote.agentid.pub"\n---', verification: { status: 'verified' }, cert_pem: '', etag: '"abc"', last_modified: '' },
  }),
  mockCheckAgentMd: vi.fn().mockResolvedValue({
    ok: true,
    data: { aid: 'test.aid', local_found: true, remote_found: true, local_etag: '"abc"', remote_etag: '"abc"', needs_update: false, ttl_days: 30 },
  }),
  mockStoreClose: vi.fn(),
  // AUNClient methods.
  mockAuthenticate: vi.fn().mockResolvedValue({ access_token: 'mock-token', gateway: 'wss://gw.example.com/aun' }),
  mockPublishAgentMd: vi.fn().mockResolvedValue({ aid: 'test.aid', etag: '"abc123"' }),
  mockClientConnect: vi.fn().mockResolvedValue(undefined),
  mockClientClose: vi.fn().mockResolvedValue(undefined),
}));

// AID value object handed back by store.load().
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
// Default load behavior: succeed with a mock AID for the requested name.
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

describe('aidCreate', () => {
  let tmpDir: string;
  let originalHomedir: () => string;
  let aidCreate: typeof import('../../src/aun/aid/index.js')['aidCreate'];
  let agentmdPut: typeof import('../../src/aun/aid/index.js')['agentmdPut'];
  let buildInitialAgentMd: typeof import('../../src/aun/aid/index.js')['buildInitialAgentMd'];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-test-'));
    originalHomedir = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);

    // Create .aun base directory
    fs.mkdirSync(path.join(tmpDir, '.aun', 'AIDs'), { recursive: true });
    process.env.EVOLCLAW_HOME = tmpDir;
    const { _resetRoot } = await import('../../src/paths.js');
    _resetRoot();

    // Reset mocks
    mockStoreRegister.mockClear();
    mockStoreLoad.mockClear();
    mockFetchAgentMd.mockClear();
    mockCheckAgentMd.mockClear();
    mockStoreClose.mockClear();
    mockAuthenticate.mockClear();
    mockPublishAgentMd.mockClear();
    mockClientConnect.mockClear();
    mockClientClose.mockClear();
    mockSignAgentMd.mockClear();
    mockVerifyAgentMd.mockClear();

    ({ aidCreate, agentmdPut, buildInitialAgentMd } = await import('../../src/aun/aid/index.js'));
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

  it('returns alreadyExisted=true when AID directory and private key exist', async () => {
    const aid = 'existing.example.pub';
    const aidDir = path.join(tmpDir, 'AIDs', aid);
    fs.mkdirSync(path.join(aidDir, 'private'), { recursive: true });
    fs.mkdirSync(path.join(aidDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(aidDir, 'public', 'cert.pem'), 'mock-cert');

    const result = await aidCreate(aid);

    expect(result.aid).toBe(aid);
    expect(result.alreadyExisted).toBe(true);
    // Existing valid identity: verifySignAbility passes, then authenticate — never register.
    expect(mockStoreRegister).not.toHaveBeenCalled();
    expect(mockSignAgentMd).toHaveBeenCalled();
    expect(mockVerifyAgentMd).toHaveBeenCalled();
    expect(mockAuthenticate).toHaveBeenCalled();
  });

  it('does not treat directory without private/ as already existing', async () => {
    const aid = 'partial.example.pub';
    const aidDir = path.join(tmpDir, 'AIDs', aid);
    fs.mkdirSync(aidDir, { recursive: true });
    // No 'private' subdirectory

    const result = await aidCreate(aid);

    expect(result.alreadyExisted).toBe(false);
    expect(mockStoreRegister).toHaveBeenCalled();
  });

  it('creates new AID and returns client', async () => {
    const aid = 'newbot.example.pub';

    const result = await aidCreate(aid);

    expect(result.aid).toBe(aid);
    expect(result.alreadyExisted).toBe(false);
    expect(result.client).toBeDefined();
    expect(mockStoreRegister).toHaveBeenCalledWith(aid);
  });

  it('aidCreate + agentmdPut writes agent.md locally', async () => {
    const aid = 'newbot.example.pub';

    const result = await aidCreate(aid);
    const content = buildInitialAgentMd({ aid });
    await agentmdPut(content, { aid, client: result.client });

    const agentMdPath = path.join(tmpDir, 'AIDs', aid, 'agent.md');
    expect(fs.existsSync(agentMdPath)).toBe(true);
    const fileContent = fs.readFileSync(agentMdPath, 'utf-8');
    expect(fileContent).toContain(`aid: "${aid}"`);
    expect(fileContent).toContain('name: "newbot"');
    expect(fileContent).toContain('type: "ai"');
    expect(fileContent).toContain('evolclaw');
  });

  it('buildInitialAgentMd extracts agent name from first label of AID', () => {
    const content = buildInitialAgentMd({ aid: 'reviewer.agentid.pub' });
    expect(content).toContain('name: "reviewer"');
  });

  it('agentmdPut does not fail if upload errors (caller handles)', async () => {
    mockPublishAgentMd.mockRejectedValueOnce(new Error('upload failed'));
    const aid = 'noupload.example.pub';

    const result = await aidCreate(aid);
    // agentmdPut WILL throw — caller is responsible for catching
    await expect(agentmdPut(buildInitialAgentMd({ aid }), { aid, client: result.client }))
      .rejects.toThrow('upload failed');
  });
});
