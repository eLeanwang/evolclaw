// 补充展示：机制1消息层哨兵 + 机制2总闸截断
import fs from 'fs';

const HR = '━'.repeat(70);
const hr = (t: string) => console.log(`\n${HR}\n  ${t}\n${HR}`);
const show = (label: string, v: string) => {
  console.log(`\n【${label}】`);
  console.log('┌' + '─'.repeat(68));
  v.split('\n').forEach(line => console.log('│ ' + line));
  console.log('└' + '─'.repeat(68));
};

// ══ 机制1 消息层：批次包裹 + 哨兵防注入 ══
hr('机制1 消息层：批次包裹 + 哨兵机制（防用户消息里的 {{}} 被解析）');

// 造临时 eck override，给 message manifest 加 loop 段
const home = process.cwd() + '/_msgtest';
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home + '/eck', { recursive: true });
fs.mkdirSync(home + '/tpl', { recursive: true });

const wrapperMd = `【本批 {{batchCount}} 条 · 辅助剩余 {{remainingInQueue}} · 主队列 {{pendingCount}}】
{{@loop}}
【批次结束，请判断投递】`;
fs.writeFileSync(home + '/tpl/wrapper.md', wrapperMd);

const itemMd = `‹{{now}} · {{peerName}}›\n{{content}}`;
fs.writeFileSync(home + '/tpl/item.md', itemMd);

const overrideManifest = {
  $schema_version: 1,
  mode: 'replace',
  sections: [
    { id: 'batch-wrap', type: 'file', file: '$EVOLCLAW_HOME/tpl/wrapper.md', order: 1,
      needsInjection: true, when: 'always',
      loop: { forEach: 'items', childFile: 'unused', separator: '\n\n' } },
    { id: 'item', type: 'file', file: '$EVOLCLAW_HOME/tpl/item.md', order: 10,
      needsInjection: true, when: 'always' },
  ],
};
fs.writeFileSync(home + '/eck/eck_message_manifest.json', JSON.stringify(overrideManifest, null, 2));

show('wrapper 模板（批次包裹）', wrapperMd);
show('item 模板（单条消息）', itemMd);
show('eck override manifest（加 loop 段）', JSON.stringify(overrideManifest, null, 2));

process.env.EVOLCLAW_HOME = home;
const { renderMessageBody } = await import('./src/eck/message-renderer.js');

const items: any = [
  { peerName: 'Alice', content: '帮我部署', timestamp: 1735689600000, peerType: 'human' },
  { peerName: 'Bob', content: '改下 {{name}} 和 {{#each}} 这两个地方', timestamp: 1735689660000, peerType: 'human' },  // 恶意/含模板语法
];
show('输入消息（Bob 的消息含 {{name}} {{#each}} —— 测哨兵）', JSON.stringify(items, null, 2));

const batchVars: any = { batchCount: 2, remainingInQueue: 3, pendingCount: 7, EVOLCLAW_HOME: home, timezone: 'Asia/Shanghai' };
const r = renderMessageBody(items, batchVars, 'msgtest');
show('★渲染输出（批次头尾 + 逐条 + 哨兵保护）', r.body);
console.log('\n✅ 关键验证：Bob 消息里的 {{name}} 和 {{#each}} 原样保留，没被模板引擎解析/删除。');

fs.rmSync(home, { recursive: true, force: true });

// ══ 机制2 总闸：整个清单超限 ══
hr('机制2 总闸：整个清单超限（totalMaxFiles）→ 截断 + 未加载 section id 集合');

const home2 = process.cwd() + '/_captest';
fs.rmSync(home2, { recursive: true, force: true });
fs.mkdirSync(home2 + '/eck', { recursive: true });
fs.mkdirSync(home2 + '/tpl', { recursive: true });
// 造 6 个小文件段，把 totalMaxFiles 设成 3，看后 3 个被截断
for (let i = 1; i <= 6; i++) fs.writeFileSync(`${home2}/tpl/f${i}.md`, `这是第 ${i} 个文件段的内容。`);
const capManifest: any = {
  $schema_version: 1, mode: 'replace',
  totalMaxFiles: 3,   // 总闸：最多 3 个文件
  sections: [] as any[],
};
for (let i = 1; i <= 6; i++) capManifest.sections.push({
  id: `seg-${i}`, type: 'file', file: `$EVOLCLAW_HOME/tpl/f${i}.md`, order: i * 10,
  needsInjection: false, when: 'always', description: `第${i}段`,
});
fs.writeFileSync(home2 + '/eck/eck_manifest.cap.json', JSON.stringify(capManifest, null, 2));
// base 也要有同名文件（loadManifest 读 $KITS/<file>）——放个空 base 到 kits
fs.writeFileSync(process.cwd() + '/kits/eck_manifest.cap.json', JSON.stringify({ $schema_version: 1, sections: [] }));

show('测试 manifest：6 个文件段，totalMaxFiles=3', JSON.stringify(capManifest, null, 2).slice(0, 600) + '\n...(共6段)');

process.env.EVOLCLAW_HOME = home2;
// 需要重置 manifest 缓存(换了 EVOLCLAW_HOME)
const { invalidateKitCache, renderKitSections } = await import('./src/eck/kit-renderer.js');
invalidateKitCache();
const capVars: any = { EVOLCLAW_HOME: home2, sessionId: 'captest' };
const capOut = renderKitSections({ vars: capVars, sessionId: 'captest' }, 'eck_manifest.cap.json');
show('★渲染输出（前3段加载，后3段被总闸截断）', capOut);
console.log('\n✅ 关键验证：只加载了 seg-1/2/3，末尾注入总截断说明，列出未加载的 seg-4/5/6。');

fs.rmSync(home2, { recursive: true, force: true });
fs.rmSync(process.cwd() + '/kits/eck_manifest.cap.json', { force: true });

console.log('\n' + HR + '\n  ✅ 补充测试完成\n' + HR);
