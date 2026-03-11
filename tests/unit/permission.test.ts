import { describe, it, expect } from 'vitest';
import { canUseTool } from '../../src/core/permission.js';

describe('Permission Control', () => {
  it('should block rm -rf commands', async () => {
    const result = await canUseTool('Bash', { command: 'rm -rf /' });
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toContain('危险命令被拦截');
    }
  });

  it('should block sudo commands', async () => {
    const result = await canUseTool('Bash', { command: 'sudo apt install' });
    expect(result.behavior).toBe('deny');
  });

  it('should allow safe commands', async () => {
    const result = await canUseTool('Bash', { command: 'ls -la' });
    expect(result.behavior).toBe('allow');
  });

  it('should allow empty commands', async () => {
    const result = await canUseTool('Bash', { command: '' });
    expect(result.behavior).toBe('allow');
  });

  it('should allow all non-Bash tools', async () => {
    const result = await canUseTool('Read', { file_path: '/etc/passwd' });
    expect(result.behavior).toBe('allow');
  });

  it('should handle multi-line commands', async () => {
    const result = await canUseTool('Bash', {
      command: 'echo "test" && \\\nsudo reboot'
    });
    expect(result.behavior).toBe('deny');
  });
});
