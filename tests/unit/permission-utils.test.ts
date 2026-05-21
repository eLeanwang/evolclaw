import { describe, it, expect, vi } from 'vitest';
import { checkBlacklist, summarizeToolInput } from '../../src/core/permission.js';
import fs from 'fs';

describe('permission-utils', () => {
  describe('checkBlacklist', () => {
    it('should allow non-Bash tools', async () => {
      const result = await checkBlacklist('Read', { file_path: '/etc/passwd' });
      expect(result.behavior).toBe('allow');
    });

    it('should allow safe Bash commands', async () => {
      const result = await checkBlacklist('Bash', { command: 'ls -la' });
      expect(result.behavior).toBe('allow');
    });

    it('should deny rm -rf', async () => {
      const result = await checkBlacklist('Bash', { command: 'rm -rf /' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny sudo commands', async () => {
      const result = await checkBlacklist('Bash', { command: 'sudo apt install' });
      expect(result.behavior).toBe('deny');
    });
  });

  describe('summarizeToolInput', () => {
    it('should extract file_path for Read', () => {
      expect(summarizeToolInput('Read', { file_path: '/tmp/test.txt' })).toBe('/tmp/test.txt');
    });

    it('should extract command for Bash', () => {
      expect(summarizeToolInput('Bash', { command: 'echo hello' })).toBe('echo hello');
    });

    it('should extract pattern for Grep', () => {
      expect(summarizeToolInput('Grep', { pattern: 'foo.*bar' })).toBe('pattern: foo.*bar');
    });

    it('should fallback to generic extraction', () => {
      expect(summarizeToolInput('Unknown', { description: 'test desc' })).toBe('test desc');
    });

    it('should return empty string for empty input', () => {
      expect(summarizeToolInput('Read', {})).toBe('');
    });

    it('should extract file_path for Edit', () => {
      expect(summarizeToolInput('Edit', { file_path: '/src/index.ts' })).toBe('/src/index.ts');
    });

    it('should extract file_path for Write', () => {
      expect(summarizeToolInput('Write', { file_path: '/tmp/out.json' })).toBe('/tmp/out.json');
    });

    it('should extract pattern for Glob', () => {
      expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('pattern: **/*.ts');
    });

    it('should extract description for Agent', () => {
      expect(summarizeToolInput('Agent', { description: 'search codebase' })).toBe('search codebase');
    });

    it('should extract prompt for Agent when no description', () => {
      expect(summarizeToolInput('Agent', { prompt: 'find all test files in the project' })).toBe('find all test files in the project');
    });

    it('should truncate long Bash commands to 80 chars', () => {
      const longCmd = 'a'.repeat(120);
      expect(summarizeToolInput('Bash', { command: longCmd })).toBe(longCmd.substring(0, 80));
    });

    it('should truncate long Agent prompts to 80 chars', () => {
      const longPrompt = 'x'.repeat(120);
      expect(summarizeToolInput('Agent', { prompt: longPrompt })).toBe(longPrompt.substring(0, 80));
    });

    it('should handle null input gracefully', () => {
      expect(summarizeToolInput('Read', null as any)).toBe('');
    });

    it('should fallback through generic chain for unknown tools', () => {
      expect(summarizeToolInput('CustomTool', { file_path: '/a/b' })).toBe('/a/b');
      expect(summarizeToolInput('CustomTool', { pattern: 'test' })).toBe('test');
      expect(summarizeToolInput('CustomTool', { command: 'echo hi' })).toBe('echo hi');
      expect(summarizeToolInput('CustomTool', { prompt: 'do stuff' })).toBe('do stuff');
    });

    describe('Edit diff formatting', () => {
      it('should use Unicode markers (− ＋) instead of ASCII (- +)', () => {
        const result = summarizeToolInput('Edit', {
          file_path: '/nonexistent/file.ts',
          old_string: 'const x = 1;',
          new_string: 'const x = 2;',
        });
        expect(result).toContain('−');
        expect(result).toContain('＋');
        expect(result).not.toMatch(/^- /m);
        expect(result).not.toMatch(/^\+ /m);
      });

      it('should show real line numbers when file is readable', () => {
        // Mock fs.readFileSync to return known content
        const fileContent = 'line1\nline2\nconst x = 1;\nline4\n';
        vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(fileContent);

        const result = summarizeToolInput('Edit', {
          file_path: '/tmp/test-file.ts',
          old_string: 'const x = 1;',
          new_string: 'const x = 2;',
        });
        // old_string starts at line 3 (1-based)
        expect(result).toContain('3 −');
        expect(result).toContain('3 ＋');

        vi.restoreAllMocks();
      });

      it('should work without line numbers when file is unreadable', () => {
        vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw new Error('ENOENT'); });

        const result = summarizeToolInput('Edit', {
          file_path: '/nonexistent/file.ts',
          old_string: 'old line',
          new_string: 'new line',
        });
        // Should still produce diff without line numbers
        expect(result).toContain('−');
        expect(result).toContain('＋');
        expect(result).toContain('/nonexistent/file.ts');

        vi.restoreAllMocks();
      });

      it('should show context lines around changes', () => {
        const fileContent = 'a\nb\nc\nd\ne\n';
        vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(fileContent);

        const result = summarizeToolInput('Edit', {
          file_path: '/tmp/ctx.ts',
          old_string: 'a\nb\nc\nd\ne',
          new_string: 'a\nb\nC\nd\ne',
        });
        // 'c' is at line 3, context should show 'a','b' before (but only CONTEXT=2 lines)
        expect(result).toContain('＋');
        expect(result).toContain('−');

        vi.restoreAllMocks();
      });
    });
  });

  describe('checkBlacklist - extended dangerous patterns', () => {
    it('should deny mkfs', async () => {
      const result = await checkBlacklist('Bash', { command: 'mkfs.ext4 /dev/sda1' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny dd if=', async () => {
      const result = await checkBlacklist('Bash', { command: 'dd if=/dev/zero of=/dev/sda' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny chmod 777', async () => {
      const result = await checkBlacklist('Bash', { command: 'chmod 777 /etc/passwd' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny shutdown', async () => {
      const result = await checkBlacklist('Bash', { command: 'shutdown -h now' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny reboot', async () => {
      const result = await checkBlacklist('Bash', { command: 'reboot' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny Windows format', async () => {
      const result = await checkBlacklist('Bash', { command: 'format C:' });
      expect(result.behavior).toBe('deny');
    });

    it('should deny reg delete', async () => {
      const result = await checkBlacklist('Bash', { command: 'reg delete HKLM\\Software' });
      expect(result.behavior).toBe('deny');
    });

    it('should allow empty Bash command', async () => {
      const result = await checkBlacklist('Bash', { command: '' });
      expect(result.behavior).toBe('allow');
    });

    it('should allow Bash with no command field', async () => {
      const result = await checkBlacklist('Bash', {});
      expect(result.behavior).toBe('allow');
    });
  });
});
