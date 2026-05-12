import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AUNChannel } from '../../src/channels/aun.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChannel(config: { aid: string; owner?: string }) {
  return new AUNChannel(config) as any;
}

function agentMdPath(aid: string) {
  const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
  return path.join(os.homedir(), '.aun', 'AIDs', aidName, 'agent.md');
}

// ── sendWelcomeMessage ────────────────────────────────────────────────────────

describe('AUNChannel.sendWelcomeMessage', () => {
  let tmpDir: string;
  let originalHomedir: () => string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aun-test-'));
    // Patch os.homedir to point to tmpDir
    originalHomedir = os.homedir;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeAgentMd(aid: string, content: string) {
    const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
    const dir = path.join(tmpDir, '.aun', 'AIDs', aidName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.md'), content, 'utf-8');
  }

  it('skips when no owner configured', async () => {
    const ch = makeChannel({ aid: 'bot.test.pub' });
    const sendMsg = vi.fn();
    ch.sendMessage = sendMsg;
    await (ch as any).sendWelcomeMessage();
    expect(sendMsg).not.toHaveBeenCalled();
  });

  it('skips when agent.md does not exist', async () => {
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice.test.pub' });
    const sendMsg = vi.fn();
    ch.sendMessage = sendMsg;
    await (ch as any).sendWelcomeMessage();
    expect(sendMsg).not.toHaveBeenCalled();
  });

  it('skips when initialized is already true', async () => {
    writeAgentMd('bot.test.pub', '---\naid: "bot.test.pub"\ninitialized: true\n---\n');
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice.test.pub' });
    const sendMsg = vi.fn();
    ch.sendMessage = sendMsg;
    await (ch as any).sendWelcomeMessage();
    expect(sendMsg).not.toHaveBeenCalled();
  });

  it('skips when initialized field is missing', async () => {
    writeAgentMd('bot.test.pub', '---\naid: "bot.test.pub"\nname: "bot"\n---\n');
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice.test.pub' });
    const sendMsg = vi.fn();
    ch.sendMessage = sendMsg;
    await (ch as any).sendWelcomeMessage();
    expect(sendMsg).not.toHaveBeenCalled();
  });

  it('sends welcome and updates agent.md when initialized is false', async () => {
    vi.useFakeTimers();
    writeAgentMd('bot.test.pub', '---\naid: "bot.test.pub"\nname: "bot"\ninitialized: false\n---\n');
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice.test.pub' });
    const mockCall = vi.fn().mockResolvedValue(undefined);
    const mockUpload = vi.fn().mockResolvedValue(undefined);
    (ch as any).client = { call: mockCall, auth: { uploadAgentMd: mockUpload } };

    const p = (ch as any).sendWelcomeMessage();
    await vi.advanceTimersByTimeAsync(3000);
    await p;

    // Welcome message sent via client.call('message.send', ...)
    expect(mockCall).toHaveBeenCalledOnce();
    expect(mockCall.mock.calls[0][0]).toBe('message.send');
    expect(mockCall.mock.calls[0][1].to).toBe('alice.test.pub');
    expect(mockCall.mock.calls[0][1].payload.text).toContain('EvolClaw');
    expect(mockCall.mock.calls[0][1].persist_required).toBe(true);

    // agent.md updated locally
    const aidDir = path.join(tmpDir, '.aun', 'AIDs', 'bot.test.pub');
    const written = fs.readFileSync(path.join(aidDir, 'agent.md'), 'utf-8');
    expect(written).toContain('initialized: true');
    expect(written).toContain('codeagent');

    // Published to network
    expect(mockUpload).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('uses owner short ID for agent name with aidLabel suffix', async () => {
    writeAgentMd('bot.test.pub', '---\ninitialized: false\n---\n');
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice123xyz.test.pub' });
    ch.sendMessage = vi.fn().mockResolvedValue(undefined);
    (ch as any).client = { auth: { uploadAgentMd: vi.fn().mockResolvedValue(undefined) } };

    await (ch as any).sendWelcomeMessage();

    const aidDir = path.join(tmpDir, '.aun', 'AIDs', 'bot.test.pub');
    const written = fs.readFileSync(path.join(aidDir, 'agent.md'), 'utf-8');
    // owner first label (before first dot), slice(0,12) = 'alice123xyz'
    // aidLabel = 'bot' (first label of aid)
    expect(written).toContain('alice123xyz的Evol助手 (bot)');
  });

  it('preserves custom name from agent.md (not equal to aidLabel)', async () => {
    writeAgentMd('bot.test.pub', '---\naid: "bot.test.pub"\nname: "MyCustomBot"\ninitialized: false\n---\n');
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice.test.pub' });
    ch.sendMessage = vi.fn().mockResolvedValue(undefined);
    (ch as any).client = { auth: { uploadAgentMd: vi.fn().mockResolvedValue(undefined) } };

    await (ch as any).sendWelcomeMessage();

    const aidDir = path.join(tmpDir, '.aun', 'AIDs', 'bot.test.pub');
    const written = fs.readFileSync(path.join(aidDir, 'agent.md'), 'utf-8');
    // Custom name preserved — not overwritten with default pattern
    expect(written).toContain('name: "MyCustomBot"');
    expect(written).not.toContain('的Evol助手');
  });

  it('generates default name when agent.md name equals aidLabel', async () => {
    // name "bot" === aidLabel "bot" → treated as default, regenerated
    writeAgentMd('bot.test.pub', '---\naid: "bot.test.pub"\nname: "bot"\ninitialized: false\n---\n');
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice.test.pub' });
    ch.sendMessage = vi.fn().mockResolvedValue(undefined);
    (ch as any).client = { auth: { uploadAgentMd: vi.fn().mockResolvedValue(undefined) } };

    await (ch as any).sendWelcomeMessage();

    const aidDir = path.join(tmpDir, '.aun', 'AIDs', 'bot.test.pub');
    const written = fs.readFileSync(path.join(aidDir, 'agent.md'), 'utf-8');
    expect(written).toContain('的Evol助手 (bot)');
  });

  it('handles @ prefix in aid', async () => {
    writeAgentMd('bot.test.pub', '---\ninitialized: false\n---\n');
    const ch = makeChannel({ aid: '@bot.test.pub', owner: 'alice.test.pub' });
    ch.sendMessage = vi.fn().mockResolvedValue(undefined);
    (ch as any).client = { auth: { uploadAgentMd: vi.fn().mockResolvedValue(undefined) } };

    await (ch as any).sendWelcomeMessage();

    // Should have found the file (no @ in path)
    const aidDir = path.join(tmpDir, '.aun', 'AIDs', 'bot.test.pub');
    const written = fs.readFileSync(path.join(aidDir, 'agent.md'), 'utf-8');
    expect(written).toContain('initialized: true');
  });

  it('still sends welcome even if uploadAgentMd fails', async () => {
    vi.useFakeTimers();
    writeAgentMd('bot.test.pub', '---\ninitialized: false\n---\n');
    const ch = makeChannel({ aid: 'bot.test.pub', owner: 'alice.test.pub' });
    const mockCall = vi.fn().mockResolvedValue(undefined);
    (ch as any).client = { call: mockCall, auth: { uploadAgentMd: vi.fn().mockRejectedValue(new Error('network')) } };

    const p = (ch as any).sendWelcomeMessage();
    await vi.advanceTimersByTimeAsync(3000);
    await p;

    // Welcome still sent despite upload failure
    expect(mockCall).toHaveBeenCalledOnce();
    expect(mockCall.mock.calls[0][0]).toBe('message.send');
    vi.useRealTimers();
  });
});

// ── getArgValue (cli.ts helper) ───────────────────────────────────────────────

describe('getArgValue', () => {
  // Inline the function since it's not exported
  function getArgValue(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  }

  it('returns value after flag', () => {
    expect(getArgValue(['--channel', 'aun'], '--channel')).toBe('aun');
  });

  it('returns undefined when flag absent', () => {
    expect(getArgValue(['--channel', 'aun'], '--aun-aid')).toBeUndefined();
  });

  it('returns undefined when flag is last arg', () => {
    expect(getArgValue(['--aun-aid'], '--aun-aid')).toBeUndefined();
  });

  it('handles multiple flags', () => {
    const args = ['--channel', 'aun', '--aun-aid', 'bot.test.pub', '--aun-owner', 'alice.test.pub'];
    expect(getArgValue(args, '--aun-aid')).toBe('bot.test.pub');
    expect(getArgValue(args, '--aun-owner')).toBe('alice.test.pub');
  });
});
