import { describe, it, expect } from 'vitest';
import { simpleRetry } from '../../../src/utils/retry.js';

describe('Retry Mechanism', () => {
  it('should succeed on first attempt', async () => {
    const fn = async () => 'success';
    const result = await simpleRetry(fn, 3);
    expect(result).toBe('success');
  });

  it('should retry on temporary failure', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 2) throw new Error('Temporary failure');
      return 'success';
    };

    const result = await simpleRetry(fn, 3);
    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('should fail after max retries', async () => {
    const fn = async () => {
      throw new Error('Permanent failure');
    };

    await expect(simpleRetry(fn, 3)).rejects.toThrow('Permanent failure');
  });
});
