import { describe, it, expect } from 'vitest';
import { mergeLayers } from '../../src/config/merge.js';
import { loadSchema, _resetSchemaCache } from '../../src/config/schema-registry.js';

describe('response_modes config merge', () => {
  it('schema declares response_modes with dict merge', () => {
    _resetSchemaCache();
    const agent = loadSchema('agent-config');
    expect(agent.fields.get('response_modes')?.merge).toBe('dict');
    const relation = loadSchema('relation-config');
    expect(relation.fields.get('response_modes')?.merge).toBe('dict');
  });

  it('dict merge: relation overrides default_group, keeps default_private', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      // defaults
      { response_modes: { default_private: 'interactive', default_group: 'proactive' } },
      // agent
      { response_modes: { default_group: 'dual-session' } },
    ], fields);
    // dict 第一层键合并：default_private 继承，default_group 被覆盖
    expect(merged.response_modes.default_private).toBe('interactive');
    expect(merged.response_modes.default_group).toBe('dual-session');
  });

  it('dict merge: configs key replaced wholesale (not recursive)', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { response_modes: { configs: { 'dual-session': { a: 1, b: 2 } } } },
      { response_modes: { configs: { 'dual-session': { b: 99 } } } },
    ], fields);
    // dict 不递归：configs 整键被高优先级覆盖
    expect(merged.response_modes.configs['dual-session']).toEqual({ b: 99 });
  });

  it('relation adds overrides without touching agent defaults', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { response_modes: { default_group: 'proactive' } },
      { response_modes: { overrides: { 'aun#grp1': { mode: 'dual-session' } } } },
    ], fields);
    expect(merged.response_modes.default_group).toBe('proactive');
    expect(merged.response_modes.overrides['aun#grp1'].mode).toBe('dual-session');
  });
});
