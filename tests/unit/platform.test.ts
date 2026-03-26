import { describe, it, expect } from 'vitest';
import {
  isWindows,
  encodePath,
  isProcessRunning,
  killProcess,
  findProcesses,
  getProcessInfo,
  commandExists,
  dirFromImportMeta,
  isMainScript,
} from '../../src/utils/platform.js';
import path from 'path';

describe('platform', () => {
  describe('isWindows', () => {
    it('should be a boolean matching current platform', () => {
      expect(typeof isWindows).toBe('boolean');
      expect(isWindows).toBe(process.platform === 'win32');
    });
  });

  describe('encodePath', () => {
    it('should encode Unix paths (forward slashes)', () => {
      expect(encodePath('/home/user/project')).toBe('-home-user-project');
    });

    it('should encode Windows paths (backslashes and colon)', () => {
      expect(encodePath('C:\\Users\\Alice\\project')).toBe('C--Users-Alice-project');
    });

    it('should encode mixed separators', () => {
      expect(encodePath('C:\\Users/mixed\\path/here')).toBe('C--Users-mixed-path-here');
    });

    it('should handle root paths', () => {
      expect(encodePath('/')).toBe('-');
      expect(encodePath('C:\\')).toBe('C--');
    });

    it('should handle paths without separators', () => {
      expect(encodePath('project')).toBe('project');
    });

    it('should handle empty string', () => {
      expect(encodePath('')).toBe('');
    });

    it('should handle deeply nested paths', () => {
      expect(encodePath('/a/b/c/d/e/f')).toBe('-a-b-c-d-e-f');
      expect(encodePath('C:\\a\\b\\c\\d\\e\\f')).toBe('C--a-b-c-d-e-f');
    });
  });

  describe('isProcessRunning', () => {
    it('should return true for current process', () => {
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    it('should return false for non-existent PID', () => {
      // PID 99999999 is very unlikely to exist
      expect(isProcessRunning(99999999)).toBe(false);
    });
  });

  describe('killProcess', () => {
    it('should not throw for non-existent PID', () => {
      expect(() => killProcess(99999999)).not.toThrow();
    });

    it('should not throw for non-existent PID with force', () => {
      expect(() => killProcess(99999999, true)).not.toThrow();
    });
  });

  describe('findProcesses', () => {
    it('should return an array', () => {
      const result = findProcesses('__nonexistent_pattern_12345__');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should find node processes', () => {
      const result = findProcesses('node');
      expect(Array.isArray(result)).toBe(true);
      // Current process should not be in results (filtered out)
      expect(result).not.toContain(process.pid);
    });
  });

  describe('getProcessInfo', () => {
    it('should return info for current process', () => {
      const info = getProcessInfo(process.pid);
      expect(typeof info).toBe('object');
      // On Unix, should have uptime and memory at minimum
      if (!isWindows) {
        expect(info.uptime).toBeDefined();
        expect(info.memory).toBeDefined();
      }
    });

    it('should return empty object for non-existent PID', () => {
      const info = getProcessInfo(99999999);
      expect(typeof info).toBe('object');
    });
  });

  describe('commandExists', () => {
    it('should find node command', () => {
      expect(commandExists('node')).toBe(true);
    });

    it('should not find non-existent command', () => {
      expect(commandExists('__nonexistent_command_xyz_123__')).toBe(false);
    });
  });

  describe('dirFromImportMeta', () => {
    it('should return the directory of current file', () => {
      const dir = dirFromImportMeta(import.meta.url);
      // Should end with tests/unit (this test file's directory)
      expect(dir.endsWith(path.join('tests', 'unit'))).toBe(true);
    });

    it('should return an absolute path', () => {
      const dir = dirFromImportMeta(import.meta.url);
      expect(path.isAbsolute(dir)).toBe(true);
    });
  });

  describe('isMainScript', () => {
    it('should return false for test file (not the entry point)', () => {
      // This test file is not the main script
      expect(isMainScript(import.meta.url)).toBe(false);
    });
  });
});
