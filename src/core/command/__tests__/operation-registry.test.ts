import { describe, it, expect } from 'vitest';
import {
  getOperationMeta,
  listOperations,
  listOperationsByCategory,
  listDangerousOperations,
  hasOperation,
} from '../operation-registry.js';

describe('Operation Registry', () => {
  describe('getOperationMeta', () => {
    it('should return operation metadata for valid operation', () => {
      const meta = getOperationMeta('model.list');
      expect(meta).not.toBeNull();
      expect(meta?.id).toBe('model.list');
      expect(meta?.category).toBe('read');
      expect(meta?.dangerous).toBe(false);
      expect(meta?.defaultScopes).toContain('relation');
    });

    it('should return null for unknown operation', () => {
      const meta = getOperationMeta('unknown.operation');
      expect(meta).toBeNull();
    });

    it('should return dangerous flag for dangerous operations', () => {
      const meta = getOperationMeta('cli.exec.raw');
      expect(meta).not.toBeNull();
      expect(meta?.dangerous).toBe(true);
      expect(meta?.category).toBe('dangerous');
    });
  });

  describe('listOperations', () => {
    it('should return all operations', () => {
      const ops = listOperations();
      expect(ops.length).toBeGreaterThan(0);
      expect(ops.some(op => op.id === 'model.list')).toBe(true);
      expect(ops.some(op => op.id === 'stats.summary')).toBe(true);
    });
  });

  describe('listOperationsByCategory', () => {
    it('should return only read operations', () => {
      const ops = listOperationsByCategory('read');
      expect(ops.every(op => op.category === 'read')).toBe(true);
      expect(ops.some(op => op.id === 'model.list')).toBe(true);
    });

    it('should return only dangerous operations', () => {
      const ops = listOperationsByCategory('dangerous');
      expect(ops.every(op => op.category === 'dangerous')).toBe(true);
      expect(ops.some(op => op.id === 'cli.exec.raw')).toBe(true);
    });

    it('should return only process operations', () => {
      const ops = listOperationsByCategory('process');
      expect(ops.every(op => op.category === 'process')).toBe(true);
    });
  });

  describe('listDangerousOperations', () => {
    it('should return all operations marked as dangerous', () => {
      const ops = listDangerousOperations();
      expect(ops.every(op => op.dangerous === true)).toBe(true);
      expect(ops.some(op => op.id === 'cli.exec.raw')).toBe(true);
      expect(ops.some(op => op.id === 'stats.sqlReadonly')).toBe(true);
      expect(ops.some(op => op.id === 'agent.delete')).toBe(true);
    });

    it('should not include non-dangerous operations', () => {
      const ops = listDangerousOperations();
      expect(ops.some(op => op.id === 'model.list')).toBe(false);
      expect(ops.some(op => op.id === 'session.list')).toBe(false);
    });
  });

  describe('hasOperation', () => {
    it('should return true for existing operations', () => {
      expect(hasOperation('model.list')).toBe(true);
      expect(hasOperation('stats.summary')).toBe(true);
      expect(hasOperation('cli.exec.raw')).toBe(true);
    });

    it('should return false for non-existing operations', () => {
      expect(hasOperation('unknown.operation')).toBe(false);
      expect(hasOperation('')).toBe(false);
    });
  });

  describe('Operation metadata integrity', () => {
    it('should have all model operations', () => {
      expect(hasOperation('model.list')).toBe(true);
      expect(hasOperation('model.current')).toBe(true);
      expect(hasOperation('model.info')).toBe(true);
      expect(hasOperation('model.check')).toBe(true);
      expect(hasOperation('model.use')).toBe(true);
      expect(hasOperation('model.effort')).toBe(true);
      expect(hasOperation('model.reset')).toBe(true);
    });

    it('should have all session operations', () => {
      expect(hasOperation('session.list')).toBe(true);
      expect(hasOperation('session.create')).toBe(true);
      expect(hasOperation('session.rename')).toBe(true);
      expect(hasOperation('session.delete')).toBe(true);
    });

    it('should have all stats operations', () => {
      expect(hasOperation('stats.summary')).toBe(true);
      expect(hasOperation('stats.sqlReadonly')).toBe(true);
      expect(hasOperation('stats.rebuild')).toBe(true);
    });

    it('should have all agent operations', () => {
      expect(hasOperation('agent.list')).toBe(true);
      expect(hasOperation('agent.show')).toBe(true);
      expect(hasOperation('agent.getConfig')).toBe(true);
      expect(hasOperation('agent.create')).toBe(true);
      expect(hasOperation('agent.reload')).toBe(true);
      expect(hasOperation('agent.delete')).toBe(true);
    });

    it('should have role assignment operations', () => {
      expect(hasOperation('role.assign')).toBe(true);
      expect(hasOperation('role.revoke')).toBe(true);
      expect(getOperationMeta('role.assign')).toMatchObject({
        category: 'write-agent',
        dangerous: false,
        defaultScopes: ['agent'],
      });
      expect(getOperationMeta('role.revoke')).toMatchObject({
        category: 'write-agent',
        dangerous: false,
        defaultScopes: ['agent'],
      });
    });

    it('should have system operations', () => {
      expect(hasOperation('system.status')).toBe(true);
      expect(hasOperation('system.restart')).toBe(true);
      expect(hasOperation('system.upgrade')).toBe(true);
    });

    it('should have ec command operations', () => {
      expect(hasOperation('ec.msg.send')).toBe(true);
      expect(hasOperation('ec.msg.file')).toBe(true);
      expect(hasOperation('ec.group.send')).toBe(true);
      expect(hasOperation('ec.group.file')).toBe(true);
      expect(hasOperation('ec.ctl.send')).toBe(true);
      expect(hasOperation('ec.ctl.file')).toBe(true);

      const msgSend = getOperationMeta('ec.msg.send');
      expect(msgSend).toMatchObject({
        category: 'write-own',
        dangerous: false,
        defaultScopes: ['relation', 'agent'],
        sources: ['agent-tool'],
      });

      const ctlSend = getOperationMeta('ec.ctl.send');
      expect(ctlSend).toMatchObject({
        category: 'write-agent',
        dangerous: false,
        defaultScopes: ['control', 'agent'],
        sources: ['agent-tool'],
      });
    });
  });

  describe('Dangerous operation validation', () => {
    it('cli.exec.raw should be dangerous', () => {
      const meta = getOperationMeta('cli.exec.raw');
      expect(meta?.dangerous).toBe(true);
    });

    it('stats.sqlReadonly should be dangerous', () => {
      const meta = getOperationMeta('stats.sqlReadonly');
      expect(meta?.dangerous).toBe(true);
    });

    it('stats.rebuild should be dangerous', () => {
      const meta = getOperationMeta('stats.rebuild');
      expect(meta?.dangerous).toBe(true);
    });

    it('agent.delete should be dangerous', () => {
      const meta = getOperationMeta('agent.delete');
      expect(meta?.dangerous).toBe(true);
    });

    it('model.list should not be dangerous', () => {
      const meta = getOperationMeta('model.list');
      expect(meta?.dangerous).toBe(false);
    });
  });
});
