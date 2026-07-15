import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/eck/manifest-engine.js';

// {{#each}} 循环语法（保留空行模式，与消息渲染一致 stripBlankLines=false）
describe('renderTemplate {{#each}}', () => {
  const r = (tpl: string, vars: any) => renderTemplate(tpl, vars, false);

  it('对象数组：元素字段可用 {{field}} 访问', () => {
    expect(r('{{#each m}}@{{name}}({{aid}}) {{/each}}', {
      m: [{ name: 'Alice', aid: 'alice.aid.pub' }, { name: 'Carol', aid: 'carol.aid.pub' }],
    })).toBe('@Alice(alice.aid.pub) @Carol(carol.aid.pub) ');
  });

  it('标量数组：{{.}} 取当前元素', () => {
    expect(r('{{#each t}}#{{.}} {{/each}}', { t: ['urgent', 'vip'] })).toBe('#urgent #vip ');
  });

  it('{{@index}} 为 0 基序号', () => {
    expect(r('{{#each x}}{{@index}}:{{.}} {{/each}}', { x: ['a', 'b', 'c'] })).toBe('0:a 1:b 2:c ');
  });

  it('空数组整块渲染为空', () => {
    expect(r('X{{#each e}}n{{/each}}Y', { e: [] })).toBe('XY');
  });

  it('非数组（undefined）整块跳过', () => {
    expect(r('X{{#each miss}}n{{/each}}Y', {})).toBe('XY');
  });

  it('嵌套 each + 条件块', () => {
    expect(r('{{#each rows}}[{{label}}{{#each subs}} {{.}}{{/each}}{{?flag}}!{{/}}]{{/each}}', {
      rows: [
        { label: 'r1', subs: ['x', 'y'], flag: true },
        { label: 'r2', subs: [], flag: false },
      ],
    })).toBe('[r1 x y!][r2]');
  });

  it('循环体内可引用外层变量', () => {
    expect(r('{{#each n}}{{greet}} {{.}}; {{/each}}', { greet: 'hi', n: ['a', 'b'] }))
      .toBe('hi a; hi b; ');
  });

  it('不影响纯标量/条件模板（无 each 时行为不变）', () => {
    expect(r('{{a}}{{?b}}-{{b}}{{/}}', { a: 'X', b: 'Y' })).toBe('X-Y');
    expect(r('{{a}}{{?b}}-{{b}}{{/}}', { a: 'X' })).toBe('X');
  });
});
