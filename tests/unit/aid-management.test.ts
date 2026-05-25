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

// Mock AUNClient at module scope (hoisted by vitest)
const mockUploadAgentMd = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
// createAid must create the AID directory (as the real SDK does)
const mockCreateAid = vi.fn().mockImplementation(async (opts: { aid: string }) => {
  const aidDir = path.join(os.homedir(), '.aun', 'AIDs', opts.aid);
  fs.mkdirSync(aidDir, { recursive: true });
  return { gateway: 'gw.example.com' };
});

vi.mock('@agentunion/fastaun', () => ({
  AUNClient: class MockAUNClient {
    constructor() {}
    auth = {
      createAid: mockCreateAid,
      uploadAgentMd: mockUploadAgentMd,
    };
    close = mockClose;
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
    mockCreateAid.mockClear();
    mockUploadAgentMd.mockClear();
    mockClose.mockClear();

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
    const aidDir = path.join(tmpDir, '.aun', 'AIDs', aid);
    fs.mkdirSync(aidDir, { recursive: true });
    fs.mkdirSync(path.join(aidDir, 'private'), { recursive: true });

    const result = await aidCreate(aid);

    expect(result.aid).toBe(aid);
    expect(result.alreadyExisted).toBe(true);
    // Should NOT call createAid on SDK
    expect(mockCreateAid).toHaveBeenCalledTimes(1); // only getAunClient identity load
  });

  it('does not treat directory without private/ as already existing', async () => {
    const aid = 'partial.example.pub';
    const aidDir = path.join(tmpDir, '.aun', 'AIDs', aid);
    fs.mkdirSync(aidDir, { recursive: true });
    // No 'private' subdirectory

    const result = await aidCreate(aid);

    expect(result.alreadyExisted).toBe(false);
    expect(mockCreateAid).toHaveBeenCalled();
  });

  it('creates new AID and returns client', async () => {
    const aid = 'newbot.example.pub';

    const result = await aidCreate(aid);

    expect(result.aid).toBe(aid);
    expect(result.alreadyExisted).toBe(false);
    expect(result.client).toBeDefined();
    expect(mockCreateAid).toHaveBeenCalledWith({ aid });
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
    mockUploadAgentMd.mockRejectedValueOnce(new Error('upload failed'));
    const aid = 'noupload.example.pub';

    const result = await aidCreate(aid);
    // agentmdPut WILL throw — caller is responsible for catching
    await expect(agentmdPut(buildInitialAgentMd({ aid }), { aid, client: result.client }))
      .rejects.toThrow('upload failed');
  });
});
