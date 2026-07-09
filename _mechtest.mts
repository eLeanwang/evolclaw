// 三机制可视化测试：展示配置、输入、输出全过程
// 用法：npx tsx _mechtest.mts

import {
  renderLoopSection, loadManifest, loadManifestMeta, loadSectionFiles,
  renderTemplate,
} from './src/eck/manifest-engine.js';

const HR = '━'.repeat(70);
const hr = (t: string) => console.log(`\n${HR}\n  ${t}\n${HR}`);
const show = (label: string, v: string) => {
  console.log(`\n【${label}】`);
  console.log('┌' + '─'.repeat(68));
  v.split('\n').forEach(line => console.log('│ ' + line));
  console.log('└' + '─'.repeat(68));
};

// ══════════════════════════════════════════════════════════════════
hr('机制1：Manifest 嵌套 + 循环（三段式 wrapper + forEach + child）');

console.log(`
说明：一个 section 用 loop 字段声明循环。file=包裹模板(wrapper)，
loop.childFile=每元素的子模板，loop.forEach=循环的数组变量名。
wrapper 里的 {{@loop}} 会被替换成"每个元素渲染 child 后用 separator 连接"的结果。
`);

const wrapperTpl = `【消息批次 · 待判断 {{batchCount}} 条 · 辅助队列剩余 {{remainingInQueue}} · 主队列 {{pendingCount}}】
{{@loop}}
【批次结束】`;

const childTpl = `  [{{@index}}] {{peerName}}（{{peerRole}}）: {{content}}`;

show('wrapper 模板文件内容', wrapperTpl);
show('child 模板文件内容', childTpl);

const loopVars: any = {
  batchCount: 3, remainingInQueue: 5, pendingCount: 12,
  messages: [
    { peerName: 'Alice', peerRole: 'owner', content: '帮我部署到生产环境' },
    { peerName: 'Bob', peerRole: 'guest', content: '这个报错怎么解决' },
    { peerName: 'Carol', peerRole: 'admin', content: '统计下上周数据' },
  ],
};
show('输入数据（vars）', JSON.stringify(loopVars, null, 2));

console.log('\n>>> 调用 renderLoopSection(wrapper, child, "messages", vars, false, 默认换行)');
const loopOut1 = renderLoopSection(wrapperTpl, childTpl, 'messages', loopVars, false, '\n');
show('★渲染输出（分隔符=换行）', loopOut1);

console.log('\n>>> 换分隔符：separator = "\\n\\n"（空行分段）');
const loopOut2 = renderLoopSection(wrapperTpl, childTpl, 'messages', loopVars, false, '\n\n');
show('★渲染输出（分隔符=空行）', loopOut2);

console.log('\n>>> 边界：空数组');
const loopOut3 = renderLoopSection(wrapperTpl, childTpl, 'messages', { ...loopVars, messages: [] }, false, '\n');
show('★渲染输出（空数组 → 循环体为空）', loopOut3);

// ══════════════════════════════════════════════════════════════════
hr('机制2：目录加载加固保护（maxFiles / maxBytes / 总闸）');

console.log(`
说明：type=directory 的段加载整个目录。两层限额：
  · 单目录段：maxFiles(默认20) / maxBytes(默认40KB)
  · 整个清单：totalMaxFiles(默认50) / totalMaxBytes(默认100KB)
超限时停止加载并注入截断说明。用真实 kits/rules 目录演示。
`);

const rulesVars: any = { KITS_RULES: process.cwd() + '/kits/rules' };
const dirBase: any = { id: 'rules', type: 'directory', path: '$KITS_RULES', order: 10, needsInjection: false, when: 'always' };

// 场景A：默认限额（不触限）
console.log('\n>>> 场景A：默认限额(20文件/40KB)，加载真实 kits/rules');
let ov: any = {};
const filesA = loadSectionFiles(dirBase, rulesVars, new Map(), ov);
console.log(`  section 配置: ${JSON.stringify({ type: 'directory', path: '$KITS_RULES' })}`);
console.log(`  实际加载文件数: ${filesA.length}`);
console.log(`  加载的文件: ${filesA.map(f => f[0].split(/[/\\]/).pop()).join(', ')}`);
console.log(`  总字节: ${filesA.reduce((n, f) => n + Buffer.byteLength(f[1], 'utf-8'), 0)}`);
console.log(`  overflow(截断): ${ov.value ? JSON.stringify(ov.value) : '无（未触限）✅'}`);

// 场景B：人为设 maxFiles=3 触发文件数限额
console.log('\n>>> 场景B：section 设 maxFiles=3（人为触发文件数限额）');
ov = {};
const dirB = { ...dirBase, maxFiles: 3 };
const filesB = loadSectionFiles(dirB, rulesVars, new Map(), ov);
console.log(`  section 配置: ${JSON.stringify({ type: 'directory', path: '$KITS_RULES', maxFiles: 3 })}`);
console.log(`  实际加载文件数: ${filesB.length}（前3个）`);
console.log(`  加载的文件: ${filesB.map(f => f[0].split(/[/\\]/).pop()).join(', ')}`);
console.log(`  overflow(截断): ${JSON.stringify(ov.value)}`);
console.log(`  → 渲染时会注入截断说明: [注意] 目录 $KITS_RULES 未完整加载：${ov.value.droppedFiles} 个文件未加载（达文件数上限 ${ov.value.limit} 个）。`);

// 场景C：人为设 maxBytes=8000 触发字节限额
console.log('\n>>> 场景C：section 设 maxBytes=8000（人为触发字节限额）');
ov = {};
const dirC = { ...dirBase, maxBytes: 8000 };
const filesC = loadSectionFiles(dirC, rulesVars, new Map(), ov);
console.log(`  section 配置: ${JSON.stringify({ type: 'directory', path: '$KITS_RULES', maxBytes: 8000 })}`);
console.log(`  实际加载文件数: ${filesC.length}`);
console.log(`  加载的文件: ${filesC.map(f => f[0].split(/[/\\]/).pop()).join(', ')}`);
console.log(`  已用字节: ${filesC.reduce((n, f) => n + Buffer.byteLength(f[1], 'utf-8'), 0)} / 上限 8000`);
console.log(`  overflow(截断): ${JSON.stringify(ov.value)}`);

// ══════════════════════════════════════════════════════════════════
hr('机制3：会话类型 → manifest 映射（sessionType → 不同 manifest）');

console.log(`
说明：agent config 里 sessionManifests 字典把 sessionType 映射到不同 manifest 文件。
response-engine 按 session.sessionType 查表 → 加载对应 manifest → 渲染。
下面对比 main(默认) 和 auxiliary 两种会话类型加载的 manifest 差异。
`);

// 展示映射配置
const sessionManifestsConfig = {
  main: 'eck_manifest.json',
  auxiliary: 'eck_manifest.auxiliary.json',
};
show('agent config.json 里的映射配置', JSON.stringify({ sessionManifests: sessionManifestsConfig }, null, 2));

console.log(`
映射链路：
  session.sessionType='auxiliary'
    → config.sessionManifests['auxiliary']
    → 'eck_manifest.auxiliary.json'
    → loadManifest('eck_manifest.auxiliary.json')
    → 两级合并 ($KITS + $ECK)
    → renderKitSections
`);

for (const [sType, file] of Object.entries(sessionManifestsConfig)) {
  console.log(`\n>>> sessionType = "${sType}"  →  加载 ${file}`);
  const sections = loadManifest(file);
  const meta = loadManifestMeta(file);
  console.log(`  段数: ${sections.length} | 总闸: ${meta.totalMaxFiles}文件/${Math.round(meta.totalMaxBytes/1024)}KB`);
  console.log(`  段列表(id → 条件):`);
  sections.forEach(s => {
    const when = s.when === 'always' ? 'always' : JSON.stringify(s.when);
    console.log(`    · ${s.id.padEnd(24)} order=${String(s.order).padEnd(4)} when=${when}`);
  });
}

// 实际渲染 auxiliary manifest 的效果
hr('机制3 续：auxiliary 会话实际渲染出的系统提示词（节选）');
const { renderKitSections } = await import('./src/eck/kit-renderer.js');
const auxRenderVars: any = {
  KITS_RULES: process.cwd() + '/kits/rules',
  KITS_DOCS: process.cwd() + '/kits/docs',
  KITS_FRAGMENTS: process.cwd() + '/kits/templates/system-fragments',
  baseAgent: 'claude', baseAgentName: 'Claude', chatType: 'group',
  sessionId: 'mechtest', selfAid: 'test.aid.pub',
};
const auxOutput = renderKitSections({ vars: auxRenderVars, sessionId: 'mechtest' }, 'eck_manifest.auxiliary.json');
console.log(`\nauxiliary 系统提示词总长度: ${auxOutput.length} 字节`);
console.log(`包含的段(从输出里的 "Contenu de" 提取):`);
const matches = auxOutput.match(/Contenu de [^\n]+/g) || [];
matches.forEach(m => console.log('  · ' + m));
show('★auxiliary 系统提示词输出（前 1500 字符）', auxOutput.slice(0, 1500));

console.log('\n' + HR);
console.log('  ✅ 三机制可视化测试完成');
console.log(HR);
