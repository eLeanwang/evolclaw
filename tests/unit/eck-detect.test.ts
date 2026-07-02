import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectEckSymlink, resolveEckInjection } from '../../src/eck/detect.js';

describe('detectEckSymlink', () => {
  let tmpDir: string;
  let kitsRulesPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eck-detect-'));
    kitsRulesPath = path.join(tmpDir, 'kits-rules');
    fs.mkdirSync(kitsRulesPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no .claude/rules/eck exists', () => {
    const projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
    expect(detectEckSymlink(projectPath, kitsRulesPath)).toBe(false);
  });

  it('returns true when symlink points to kitsRulesPath', () => {
    const projectPath = path.join(tmpDir, 'project');
    const eckDir = path.join(projectPath, '.claude', 'rules', 'eck');
    fs.mkdirSync(path.dirname(eckDir), { recursive: true });
    fs.symlinkSync(kitsRulesPath, eckDir, 'junction');
    expect(detectEckSymlink(projectPath, kitsRulesPath)).toBe(true);
  });

  it('returns false when symlink points elsewhere', () => {
    const projectPath = path.join(tmpDir, 'project');
    const eckDir = path.join(projectPath, '.claude', 'rules', 'eck');
    const otherDir = path.join(tmpDir, 'other');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.mkdirSync(path.dirname(eckDir), { recursive: true });
    fs.symlinkSync(otherDir, eckDir, 'junction');
    expect(detectEckSymlink(projectPath, kitsRulesPath)).toBe(false);
  });

  it('finds symlink in parent directory (up to 5 levels)', () => {
    const eckDir = path.join(tmpDir, '.claude', 'rules', 'eck');
    fs.mkdirSync(path.dirname(eckDir), { recursive: true });
    fs.symlinkSync(kitsRulesPath, eckDir, 'junction');

    const deepProject = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(deepProject, { recursive: true });
    expect(detectEckSymlink(deepProject, kitsRulesPath)).toBe(true);
  });
});

describe('resolveEckInjection', () => {
  let tmpDir: string;
  let kitsRulesPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eck-inject-'));
    kitsRulesPath = path.join(tmpDir, 'kits-rules');
    fs.mkdirSync(kitsRulesPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns shouldInject=true for codex (no autoload)', () => {
    const result = resolveEckInjection({ baseAgent: 'codex' }, tmpDir, kitsRulesPath);
    expect(result.shouldInject).toBe(true);
    expect(result.reason).toBe('baseagent-no-autoload');
  });

  it('returns shouldInject=false for claude with symlink', () => {
    const eckDir = path.join(tmpDir, '.claude', 'rules', 'eck');
    fs.mkdirSync(path.dirname(eckDir), { recursive: true });
    fs.symlinkSync(kitsRulesPath, eckDir, 'junction');

    const result = resolveEckInjection({ baseAgent: 'claude' }, tmpDir, kitsRulesPath);
    expect(result.shouldInject).toBe(false);
    expect(result.reason).toBe('symlink-active');
  });

  it('returns shouldInject=true for claude without symlink', () => {
    const result = resolveEckInjection({ baseAgent: 'claude' }, tmpDir, kitsRulesPath);
    expect(result.shouldInject).toBe(true);
    expect(result.reason).toBe('symlink-not-found');
  });

  it('returns shouldInject=true for unknown baseagent', () => {
    const result = resolveEckInjection({ baseAgent: 'unknown-agent' }, tmpDir, kitsRulesPath);
    expect(result.shouldInject).toBe(true);
    expect(result.reason).toBe('baseagent-no-autoload');
  });
});
