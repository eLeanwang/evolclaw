import { describe, it, expect } from 'vitest';
import { parseCliIntent, rawCliIntent, withDefaultRelationContext } from '../cli-intent-parser.js';

describe('CLI Intent Parser', () => {
  describe('Model commands', () => {
    it('should parse model list', () => {
      const result = parseCliIntent(['model', 'list', '--self', 'agent1', '--peer', 'user1']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('model.list');
        expect(result.intent.scope).toBe('relation');
        expect(result.intent.args).toEqual({ self: 'agent1', peer: 'user1' });
      }
    });

    it('should parse model current', () => {
      const result = parseCliIntent(['model', 'current', '--self', 'agent1']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('model.current');
        expect(result.intent.scope).toBe('agent');
      }
    });

    it('should parse model use', () => {
      const result = parseCliIntent(['model', 'use', 'opus', '--self', 'agent1', '--peer', 'user1']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('model.use');
        expect(result.intent.scope).toBe('relation');
        expect(result.intent.args.model).toBe('opus');
      }
    });

    it('should reject --role flag', () => {
      const result = parseCliIntent(['model', 'list', '--role', 'admin']);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.code).toBe('FORBIDDEN_FLAG');
      }
    });

    it('should add current relation context for menu cli model list', () => {
      const argv = withDefaultRelationContext(['model', 'list'], { self: 'agent1', peer: 'aun#user1' });
      expect(argv).toEqual(['model', 'list', '--self', 'agent1', '--peer', 'aun#user1']);

      const result = parseCliIntent(argv);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('model.list');
        expect(result.intent.scope).toBe('relation');
        expect(result.intent.args).toEqual({ self: 'agent1', peer: 'aun#user1' });
      }
    });

    it('should not override explicit model command scope', () => {
      const argv = withDefaultRelationContext(['model', 'list', '--self', 'agent2'], { self: 'agent1', peer: 'aun#user1' });
      expect(argv).toEqual(['model', 'list', '--self', 'agent2']);
    });
  });

  describe('Stats commands', () => {
    it('should parse stats summary', () => {
      const result = parseCliIntent(['stats']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('stats.summary');
      }
    });

    it('should parse stats --sql as dangerous', () => {
      const result = parseCliIntent(['stats', '--sql', 'SELECT * FROM messages']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('stats.sqlReadonly');
        expect(result.intent.dangerous).toBe(true);
      }
    });

    it('should parse stats --rebuild as dangerous', () => {
      const result = parseCliIntent(['stats', '--rebuild']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('stats.rebuild');
        expect(result.intent.dangerous).toBe(true);
      }
    });
  });

  describe('Agent commands', () => {
    it('should parse agent list', () => {
      const result = parseCliIntent(['agent', 'list']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('agent.list');
        expect(result.intent.scope).toBe('control');
      }
    });

    it('should parse agent get as dangerous', () => {
      const result = parseCliIntent(['agent', 'get', '--aid', 'agent1']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('agent.getConfig');
        expect(result.intent.dangerous).toBe(true);
      }
    });
  });

  describe('Unknown commands', () => {
    it('should map unknown command to cli.exec.raw', () => {
      const result = parseCliIntent(['unknown', 'command']);
      expect(result.kind).toBe('raw');
      if (result.kind === 'raw') {
        expect(result.intent.operation).toBe('cli.exec.raw');
        expect(result.intent.dangerous).toBe(true);
      }
    });

    it('should build raw intent for command string passthrough', () => {
      const intent = rawCliIntent(['model list --self agent1 --peer user1']);
      expect(intent.operation).toBe('cli.exec.raw');
      expect(intent.scope).toBe('raw-cli');
      expect(intent.dangerous).toBe(true);
      expect(intent.rawArgv).toEqual(['model list --self agent1 --peer user1']);
    });
  });

  describe('Status command', () => {
    it('should parse status', () => {
      const result = parseCliIntent(['status']);
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.intent.operation).toBe('system.status');
        expect(result.intent.scope).toBe('process');
      }
    });
  });
});
