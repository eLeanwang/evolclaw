import { describe, it, expect } from 'vitest';
import { normalizeCliArgv, parseCliIntent, parseLegacyCliCommand, rawCliIntent, validateCliArgv, withDefaultRelationContext } from '../../../src/core/command/cli-intent-parser.js';
import { parseConfigSelector } from '../../../src/cli/config-selector.js';
import { resolveConfigCommand, resolveConfigOperation } from '../../../src/config/resolved-config-op.js';

describe('CLI Intent Parser', () => {
  describe('Menu CLI argv validation', () => {
    it('accepts bounded string argv', () => {
      expect(validateCliArgv(['stats', '--format', 'json'])).toEqual({ ok: true, argv: ['stats', '--format', 'json'] });
    });

    it('rejects non-string, oversized and NUL argv', () => {
      expect(validateCliArgv(['stats', 1] as any).ok).toBe(false);
      expect(validateCliArgv(Array.from({ length: 65 }, () => 'x')).ok).toBe(false);
      expect(validateCliArgv(['stats', 'bad\0value']).ok).toBe(false);
    });

    it('parses legacy command quoting without invoking a shell', () => {
      expect(parseLegacyCliCommand('stats --session "session one" --format json')).toEqual({
        ok: true,
        argv: ['stats', '--session', 'session one', '--format', 'json'],
      });
    });

    it('rejects shell operators in legacy command', () => {
      expect(parseLegacyCliCommand('stats | whoami').ok).toBe(false);
      expect(parseLegacyCliCommand('stats && whoami').ok).toBe(false);
      expect(parseLegacyCliCommand('stats $(whoami)').ok).toBe(false);
    });
  });

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

  describe('Config commands', () => {
    it('distinguishes relation, agent, defaults, and process selectors', () => {
      expect(parseConfigSelector(['--self', 'agent1', '--peer', 'user1'], { requireSelector: true }))
        .toEqual({ ok: true, scope: 'relation', self: 'agent1', peerKey: 'aun#user1' });
      expect(parseConfigSelector(['--self', 'agent1'], { requireSelector: true }))
        .toEqual({ ok: true, scope: 'agent', self: 'agent1' });
      expect(parseConfigSelector(['--default'], { requireSelector: true }))
        .toEqual({ ok: true, scope: 'defaults' });
      expect(parseConfigSelector(['--evolclaw'], { requireSelector: true }))
        .toEqual({ ok: true, scope: 'process' });
    });

    it('fails closed for missing and conflicting selectors', () => {
      expect(parseConfigSelector([], { requireSelector: true })).toMatchObject({ ok: false, code: 'SELECTOR_REQUIRED' });
      expect(parseConfigSelector(['--peer', 'user1'], { requireSelector: true })).toMatchObject({ ok: false, code: 'PEER_WITHOUT_SELF' });
      expect(parseConfigSelector(['--self'], { requireSelector: true })).toMatchObject({ ok: false, code: 'MISSING_FLAG_VALUE' });
      expect(parseConfigSelector(['--self', 'a', '--self', 'b'], { requireSelector: true })).toMatchObject({ ok: false, code: 'SELECTOR_CONFLICT' });
      expect(parseConfigSelector(['--self', 'a', '--default'], { requireSelector: true })).toMatchObject({ ok: false, code: 'SELECTOR_CONFLICT' });
      expect(parseConfigSelector(['--process', '--default'], { requireSelector: true })).toMatchObject({ ok: false, code: 'SELECTOR_CONFLICT' });
    });

    it('parses relation get, set, and unset operations', () => {
      const cases = [
        { argv: ['config', 'get', 'chatmode.private', '--self', 'agent1', '--peer', 'aun#user1'], operation: 'config.get', value: undefined },
        { argv: ['config', 'set', 'chatmode.private', 'interactive', '--self', 'agent1', '--peer', 'aun#user1'], operation: 'config.set', value: 'interactive' },
        { argv: ['config', 'unset', 'chatmode.private', '--self', 'agent1', '--peer', 'aun#user1'], operation: 'config.unset', value: undefined },
      ];

      for (const testCase of cases) {
        const result = parseCliIntent(testCase.argv);
        expect(result.kind).toBe('recognized');
        if (result.kind === 'recognized') {
          expect(result.intent).toMatchObject({
            operation: testCase.operation,
            scope: 'relation',
            args: {
              field: 'chatmode.private',
              self: 'agent1',
              peer: 'aun#user1',
              peerKey: 'aun#user1',
              configScope: 'relation',
            },
          });
          expect(result.intent.args.value).toBe(testCase.value);
        }
      }
    });

    it('normalizes executable prefixes and resolves the current relation', () => {
      expect(normalizeCliArgv(['ec', 'config', 'get', 'chatmode.private']))
        .toEqual(['config', 'get', 'chatmode.private']);
      expect(normalizeCliArgv(['evolclaw', 'config', 'get', 'chatmode.private']))
        .toEqual(['config', 'get', 'chatmode.private']);

      const result = parseCliIntent(
        ['ec', 'config', 'set', 'chatmode.private', 'proactive'],
        'menu.cli',
        { defaultRelation: { self: 'agent1', peer: 'aun#user1' } },
      );
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.resolvedConfigOp?.canonicalArgv).toEqual([
          'config', 'set', 'chatmode.private', 'proactive',
          '--self', 'agent1', '--peer', 'aun#user1',
        ]);
        expect(result.intent.rawArgv).toEqual(result.resolvedConfigOp?.canonicalArgv);
      }

      // Default relation injection for config is owned by the config resolver.
      expect(withDefaultRelationContext(
        ['ec', 'config', 'set', 'chatmode.private', 'proactive'],
        { self: 'agent1', peer: 'aun#user1' },
      )).toEqual(['config', 'set', 'chatmode.private', 'proactive']);
    });

    it('does not inject defaults over explicit config selectors', () => {
      const result = parseCliIntent(
        ['config', 'set', 'chatmode.private', 'interactive', '--self', 'agent2'],
        'menu.cli',
        { defaultRelation: { self: 'agent1', peer: 'aun#user1' } },
      );
      expect(result.kind).toBe('recognized');
      if (result.kind === 'recognized') {
        expect(result.resolvedConfigOp?.canonicalArgv)
          .toEqual(['config', 'set', 'chatmode.private', 'interactive', '--self', 'agent2']);
      }
    });

    it('resolves canonical config argv deterministically and idempotently', () => {
      const first = resolveConfigOperation(
        ['ec', 'config', 'set', 'chatmode.private', 'proactive', '--format', 'json'],
        { defaultRelation: { self: 'agent1', peerKey: 'aun#user1' } },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const repeated = resolveConfigOperation(
        ['ec', 'config', 'set', 'chatmode.private', 'proactive', '--format', 'json'],
        { defaultRelation: { self: 'agent1', peerKey: 'aun#user1' } },
      );
      const canonical = resolveConfigOperation(first.op.canonicalArgv);
      expect(repeated).toEqual(first);
      expect(canonical).toEqual(first);
    });

    it('upgrades sensitive and process fields to dangerous management operations', () => {
      const sensitiveRead = parseCliIntent(['config', 'get', 'owners', '--self', 'agent1']);
      expect(sensitiveRead.kind).toBe('recognized');
      if (sensitiveRead.kind === 'recognized') {
        expect(sensitiveRead.intent).toMatchObject({ operation: 'config.read', scope: 'agent', dangerous: true });
      }

      const sensitiveWrite = parseCliIntent(['config', 'set', 'owners', 'owner1', '--self', 'agent1']);
      expect(sensitiveWrite.kind).toBe('recognized');
      if (sensitiveWrite.kind === 'recognized') {
        expect(sensitiveWrite.intent).toMatchObject({ operation: 'config.write', scope: 'agent', dangerous: true });
      }

      const processWrite = parseCliIntent(['config', 'set', 'debug', 'true', '--process']);
      expect(processWrite.kind).toBe('recognized');
      if (processWrite.kind === 'recognized') {
        expect(processWrite.intent).toMatchObject({ operation: 'config.write', scope: 'process', dangerous: true });
        expect(processWrite.intent.args.configScope).toBe('process');
      }
    });

    it('keeps global config management commands process-scoped', () => {
      for (const argv of [
        ['config', 'list'],
        ['config', 'history'],
        ['config', 'snapshot', '--full'],
        ['config', 'restore', 'v1'],
      ]) {
        const result = parseCliIntent(argv);
        expect(result.kind).toBe('recognized');
        if (result.kind === 'recognized') {
          expect(result.intent.scope).toBe('process');
          expect(result.intent.dangerous).toBe(true);
          expect(result.intent.operation).toBe(`config.${argv[1]}`);
        }
      }
    });

    it('strictly resolves every management command with idempotent canonical argv', () => {
      const commands = [
        ['config', 'show', '--self', 'agent1'],
        ['config', 'effective', '--self', 'agent1', '--peer', 'aun#user1'],
        ['config', 'fields', 'chatmode'],
        ['config', 'validate', '--self', 'agent1'],
        ['config', 'init', '--self', 'agent1', '--peer', 'aun#user1'],
        ['config', 'list'],
        ['config', 'snapshot', '--full', '--desc', 'before-change'],
        ['config', 'prune', '--keep-full', '2', '--keep-delta', '4', '--yes'],
        ['config', 'history'],
        ['config', 'diff', 'v1', 'v2'],
        ['config', 'restore', 'v1'],
        ['config', 'current'],
        ['config', 'boots', '--num', '5'],
      ];

      for (const argv of commands) {
        const first = resolveConfigCommand(argv);
        expect(first.ok).toBe(true);
        if (!first.ok) continue;
        expect(first.command.operationId).toBe(`config.${argv[1]}`);
        expect(first.command.dangerous).toBe(true);
        expect(resolveConfigCommand(first.command.canonicalArgv)).toEqual(first);
      }
    });

    it('rejects loose management-command grammar', () => {
      for (const testCase of [
        { argv: ['config', 'history', 'extra'], code: 'INVALID_CONFIG_COMMAND' },
        { argv: ['config', 'diff', 'v1'], code: 'MISSING_ARG' },
        { argv: ['config', 'restore', 'v1', 'v2'], code: 'INVALID_CONFIG_COMMAND' },
        { argv: ['config', 'snapshot', '--full', '--full'], code: 'SELECTOR_CONFLICT' },
        { argv: ['config', 'prune', '--keep-full', '-1'], code: 'MISSING_FLAG_VALUE' },
        { argv: ['config', 'boots', '-n', '0'], code: 'INVALID_CONFIG_VALUE' },
        { argv: ['config', 'show'], code: 'SELECTOR_REQUIRED' },
      ]) {
        const result = resolveConfigCommand(testCase.argv);
        expect(result).toMatchObject({ ok: false, code: testCase.code });
      }
    });

    it('rejects missing, conflicting, and ambiguous config arguments', () => {
      const cases = [
        { argv: ['config', 'set', 'chatmode.private', 'interactive'], code: 'SELECTOR_REQUIRED' },
        { argv: ['config', 'set', 'chatmode.private', 'interactive', '--peer', 'user1'], code: 'PEER_WITHOUT_SELF' },
        { argv: ['config', 'set', 'chatmode.private', 'interactive', '--self', 'agent1', '--process'], code: 'SELECTOR_CONFLICT' },
        { argv: ['config', 'set', 'chatmode.private', 'interactive', 'extra', '--self', 'agent1'], code: 'INVALID_CONFIG_COMMAND' },
        { argv: ['config', 'set', 'chatmode', '{}', '--self', 'agent1'], code: 'UNSUPPORTED_CONFIG_VALUE' },
      ];

      for (const testCase of cases) {
        const result = parseCliIntent(testCase.argv);
        expect(result.kind).toBe('invalid');
        if (result.kind === 'invalid') expect(result.code).toBe(testCase.code);
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
