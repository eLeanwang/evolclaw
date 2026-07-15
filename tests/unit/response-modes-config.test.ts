import { describe, it, expect } from 'vitest';
import { mergeLayers } from '../../src/config/merge.js';
import { loadSchema, _resetSchemaCache } from '../../src/config/schema-registry.js';

/**
 * 响应模式配置的合并语义（single-session 合并后）：
 *   - responseMode：标量（scalar merge），关系级覆盖 agent 级
 *   - responseModeParams：字典（dict merge），按模式 id 分桶，第一层键合并
 * 旧的 response_modes 块（default_private/default_group/configs/overrides）已废除。
 */
describe('responseMode / responseModeParams config merge', () => {
  it('schema declares responseMode(scalar) + responseModeParams(dict)', () => {
    _resetSchemaCache();
    const agent = loadSchema('agent-config');
    expect(agent.fields.get('responseMode')?.merge).toBe('scalar');
    expect(agent.fields.get('responseModeParams')?.merge).toBe('dict');
    const relation = loadSchema('relation-config');
    expect(relation.fields.get('responseMode')?.merge).toBe('scalar');
    expect(relation.fields.get('responseModeParams')?.merge).toBe('dict');
  });

  it('scalar merge: relation responseMode overrides agent', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { responseMode: 'single-session' },  // agent
      { responseMode: 'dual-session' },    // relation
    ], fields);
    expect(merged.responseMode).toBe('dual-session');
  });

  it('scalar merge: relation without responseMode keeps agent value', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { responseMode: 'single-session' },
      { chatmode: { private: 'proactive' } },  // relation 只改别的字段
    ], fields);
    expect(merged.responseMode).toBe('single-session');
  });

  it('dict merge: responseModeParams first-level key merged, per-mode bucket replaced wholesale', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { responseModeParams: { 'dual-session': { a: 1, b: 2 }, 'single-session': {} } },
      { responseModeParams: { 'dual-session': { b: 99 } } },
    ], fields);
    // dict 不递归：dual-session 整桶被高优先级覆盖；single-session 桶继承
    expect(merged.responseModeParams['dual-session']).toEqual({ b: 99 });
    expect(merged.responseModeParams['single-session']).toEqual({});
  });

  it('relation adds a mode bucket without touching agent buckets', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { responseModeParams: { 'dual-session': { debounceMs: 3000 } } },
      { responseModeParams: { 'workflow': { taskQueueSize: 10 } } },
    ], fields);
    expect(merged.responseModeParams['dual-session'].debounceMs).toBe(3000);
    expect(merged.responseModeParams['workflow'].taskQueueSize).toBe(10);
  });
});
