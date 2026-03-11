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

console.log('\n=== 测试 Markdown 转换 ===\n');

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

console.log('\n=== 测试简单文本 ===\n');

const simpleText = 'Hello, this is a simple message without markdown.';
const simpleResult = markdownToFeishuPost(simpleText);
console.log('简单文本转换结果：');
console.log(JSON.stringify(simpleResult, null, 2));
