import { markdownToFeishuPost, hasMarkdownSyntax } from '../src/utils/markdown-to-feishu.js';

console.log('=== 测试 Markdown 检测 ===\n');

const testCases = [
  { text: 'Hello world', expected: false },
  { text: '# Title', expected: true },
  { text: '**bold text**', expected: true },
  { text: 'normal text with `code`', expected: true },
  { text: '[link](https://example.com)', expected: true },
  { text: '- list item', expected: true },
];

testCases.forEach(({ text, expected }) => {
  const result = hasMarkdownSyntax(text);
  const status = result === expected ? '✓' : '✗';
  console.log(`${status} "${text}" => ${result} (expected: ${expected})`);
});

console.log('\n=== 测试 Markdown 转换 (md tag) ===\n');

const markdown = `# 测试标题

这是一段**粗体文本**和*斜体文本*。

## 代码示例

这是行内代码：\`console.log('hello')\`

代码块：
\`\`\`javascript
function test() {
  return 42;
}
\`\`\`

## 列表

- 第一项
- 第二项
- 第三项

## 链接

访问 [OpenClaw](https://github.com/openclaw) 了解更多。

这是~~删除线~~文本。
`;

const result = markdownToFeishuPost(markdown);
console.log('转换结果：');
console.log(JSON.stringify(result, null, 2));

// 验证结构
console.log('\n=== 结构验证 ===\n');
console.log('标题提取:', result.zh_cn.title === '测试标题' ? '✓' : '✗');
console.log('使用 md tag:', result.zh_cn.content[0][0].tag === 'md' ? '✓' : '✗');
console.log('body 不含 # 标题:', !result.zh_cn.content[0][0].text?.startsWith('# ') ? '✓' : '✗');

console.log('\n=== 测试无标题文本 ===\n');

const noTitle = '这是一段没有标题的 **Markdown** 文本。';
const noTitleResult = markdownToFeishuPost(noTitle);
console.log('无标题结果：');
console.log(JSON.stringify(noTitleResult, null, 2));
console.log('标题为空:', noTitleResult.zh_cn.title === '' ? '✓' : '✗');

console.log('\n=== 测试 defaultTitle ===\n');

const withDefault = markdownToFeishuPost(noTitle, '默认标题');
console.log('使用 defaultTitle:', withDefault.zh_cn.title === '默认标题' ? '✓' : '✗');
