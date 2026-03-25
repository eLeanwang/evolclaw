/**
 * Markdown 到飞书富文本格式转换工具
 * 使用飞书 post 格式的 md tag 原生渲染 Markdown
 */

interface PostElement {
  tag: string;
  text?: string;
}

interface PostContent {
  zh_cn: {
    title: string;
    content: Array<Array<PostElement>>;
  };
}

/**
 * 计算字符串的显示宽度（CJK 字符按 2 宽度计算）
 */
function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    // CJK Unified Ideographs, CJK Compatibility, Fullwidth Forms, etc.
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified
      (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
      (code >= 0xF900 && code <= 0xFAFF) ||   // CJK Compatibility
      (code >= 0xFF01 && code <= 0xFF60) ||   // Fullwidth Forms
      (code >= 0x3000 && code <= 0x303F)      // CJK Symbols
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 用空格填充字符串到指定显示宽度
 */
function padToWidth(str: string, targetWidth: number): string {
  const current = displayWidth(str);
  const padding = Math.max(0, targetWidth - current);
  return str + ' '.repeat(padding);
}

/**
 * 将 Markdown 表格转换为代码块内的对齐文本
 * 飞书 post md tag 不支持标准 markdown 表格，会静默丢弃内容
 * 用代码块 + 等宽对齐保留二维结构
 */
function convertTablesToText(text: string): string {
  const tableRegex = /^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)+)/gm;

  return text.replace(tableRegex, (_match, headerLine: string, _sep: string, bodyBlock: string) => {
    const parseRow = (line: string) => line.split('|').slice(1, -1).map((c: string) => c.trim());
    const headers = parseRow(headerLine);
    const rows = bodyBlock.trim().split('\n').map(parseRow);

    // 计算每列最大显示宽度
    const colWidths = headers.map((h, i) => {
      const cellWidths = rows.map(r => displayWidth(r[i] || ''));
      return Math.max(displayWidth(h), ...cellWidths);
    });

    // 构建对齐的表格文本
    const headerStr = headers.map((h, i) => padToWidth(h, colWidths[i])).join('  ');
    const sepStr = colWidths.map(w => '-'.repeat(w)).join('  ');
    const rowStrs = rows.map(r =>
      headers.map((_, i) => padToWidth(r[i] || '', colWidths[i])).join('  ')
    );

    return '```\n' + [headerStr, sepStr, ...rowStrs].join('\n') + '\n```';
  });
}

/**
 * 将 Markdown 文本转换为飞书 post 消息格式
 * 利用 md tag 让飞书原生渲染，支持代码高亮、嵌套列表、引用等全部语法
 */
export function markdownToFeishuPost(markdown: string, defaultTitle?: string): PostContent {
  const match = markdown.match(/^# (.+)$/m);
  const title = match?.[1] ?? defaultTitle ?? '';
  let body = match ? markdown.replace(/^# .+\n?/, '') : markdown;

  // 转换飞书不支持的 markdown 表格
  body = convertTablesToText(body);

  return {
    zh_cn: {
      title,
      content: [[{ tag: 'md', text: body.trim() }]]
    }
  };
}

/**
 * 检测文本是否包含 Markdown 语法
 */
export function hasMarkdownSyntax(text: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m,           // 标题
    /\*\*.*?\*\*/,          // 粗体
    /\*.*?\*/,              // 斜体
    /__.*?__/,              // 粗体
    /_.*?_/,                // 斜体
    /~~.*?~~/,              // 删除线
    /`.*?`/,                // 行内代码
    /```[\s\S]*?```/,       // 代码块
    /\[.*?\]\(.*?\)/,       // 链接
    /^[\s]*[-*+]\s/m,       // 无序列表
    /^[\s]*\d+\.\s/m,       // 有序列表
    /^\|.+\|$/m             // 表格
  ];

  return markdownPatterns.some(pattern => pattern.test(text));
}
