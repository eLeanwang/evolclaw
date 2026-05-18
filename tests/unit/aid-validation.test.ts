import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { checkAgentDir, isValidAid } from '../../src/utils/aid-validation.js';

describe('aid-validation', () => {
  it('isValidAid accepts standard 2nd+ level domain', () => {
    expect(isValidAid('alice.agentid.pub')).toBe(true);
    expect(isValidAid('review-bot.dept.example.agentid.pub')).toBe(true);
  });

  it('isValidAid rejects malformed', () => {
    expect(isValidAid('alice')).toBe(false);          // 1 label
    expect(isValidAid('alice.pub')).toBe(false);      // 2 labels
    expect(isValidAid('-leading.agentid.pub')).toBe(false);
    expect(isValidAid('trailing-.agentid.pub')).toBe(false);
    expect(isValidAid('has spaces.agentid.pub')).toBe(false);
    expect(isValidAid('.dotstart.agentid.pub')).toBe(false);
  });

  it('checkAgentDir requires valid AID + config.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-aid-'));
    fs.mkdirSync(path.join(root, 'alice.agentid.pub'));
    expect(checkAgentDir(root, 'alice.agentid.pub')).toMatch(/missing.*config\.json/);

    fs.writeFileSync(path.join(root, 'alice.agentid.pub', 'config.json'), '{}');
    expect(checkAgentDir(root, 'alice.agentid.pub')).toBeNull();

    fs.mkdirSync(path.join(root, 'not-an-aid'));
    fs.writeFileSync(path.join(root, 'not-an-aid', 'config.json'), '{}');
    expect(checkAgentDir(root, 'not-an-aid')).toMatch(/not a valid AID/);
  });
});
