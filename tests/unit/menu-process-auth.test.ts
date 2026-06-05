import { describe, it, expect } from 'vitest';
import { isProcessLevelOwner } from '../../src/core/command-handler.js';

describe('isProcessLevelOwner (owners from evolclaw.json)', () => {
  it('allows AID in owners list', () => {
    expect(isProcessLevelOwner('a.agentid.pub', ['a.agentid.pub'])).toBe(true);
  });
  it('rejects AID not in owners', () => {
    expect(isProcessLevelOwner('b.agentid.pub', ['a.agentid.pub'])).toBe(false);
  });
  it('rejects when owners undefined', () => {
    expect(isProcessLevelOwner('a.agentid.pub', undefined)).toBe(false);
  });
  it('rejects when owners empty', () => {
    expect(isProcessLevelOwner('a.agentid.pub', [])).toBe(false);
  });
  it('rejects empty peerId', () => {
    expect(isProcessLevelOwner('', ['a.agentid.pub'])).toBe(false);
  });
});
