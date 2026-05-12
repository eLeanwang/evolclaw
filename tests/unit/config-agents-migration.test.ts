import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../../src/config.js';

describe('loadConfig agents key migration', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-migration-'));
    configPath = path.join(tmpDir, 'evolclaw.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(content: any): void {
    fs.writeFileSync(configPath, JSON.stringify(content, null, 2), 'utf-8');
  }

  function read(): any {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  it('renames anthropic → claude, openai → codex, google → gemini', () => {
    write({
      agents: {
        defaultAgent: 'claude',
        anthropic: { model: 'opus' },
        openai: { model: 'gpt-5' },
        google: { model: 'gemini-2.5-flash' },
      },
      projects: { defaultPath: tmpDir },
    });

    const config = loadConfig(configPath);

    expect((config as any).agents.claude).toEqual({ model: 'opus' });
    expect((config as any).agents.codex).toEqual({ model: 'gpt-5' });
    expect((config as any).agents.gemini).toEqual({ model: 'gemini-2.5-flash' });
    expect((config as any).agents.anthropic).toBeUndefined();
    expect((config as any).agents.openai).toBeUndefined();
    expect((config as any).agents.google).toBeUndefined();

    const onDisk = read();
    expect(onDisk.agents.claude).toEqual({ model: 'opus' });
    expect(onDisk.agents.anthropic).toBeUndefined();
  });

  it('leaves config untouched when only new keys are present', () => {
    const original = {
      agents: {
        defaultAgent: 'claude',
        claude: { model: 'sonnet' },
      },
      projects: { defaultPath: tmpDir },
    };
    write(original);
    const before = fs.statSync(configPath).mtimeMs;

    loadConfig(configPath);

    const onDisk = read();
    expect(onDisk).toEqual(original);
    const after = fs.statSync(configPath).mtimeMs;
    expect(after).toBe(before);
  });

  it('drops legacy key when both old and new keys exist', () => {
    write({
      agents: {
        defaultAgent: 'claude',
        claude: { model: 'sonnet' },
        anthropic: { model: 'opus' },
      },
      projects: { defaultPath: tmpDir },
    });

    const config = loadConfig(configPath);

    expect((config as any).agents.claude).toEqual({ model: 'sonnet' });
    expect((config as any).agents.anthropic).toBeUndefined();
  });

  it('handles config with no agents block', () => {
    write({ projects: { defaultPath: tmpDir } });
    expect(() => loadConfig(configPath)).not.toThrow();
  });
});
