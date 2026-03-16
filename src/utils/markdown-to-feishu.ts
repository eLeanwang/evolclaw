/**
 * Markdown 到飞书富文本格式转换工具
 * 支持将 Markdown 文本转换为飞书 post 消息格式
 */

interface TextElement {
  tag: string;
  text?: string;
  href?: string;
  style?: string[];
}

interface PostContent {
  zh_cn: {
    title: string;
    content: Array<Array<TextElement>>;
  };
}

/**
 * 将 Markdown 文本转换为飞书 post 消息格式
 */
export function markdownToFeishuPost(markdown: string, defaultTitle?: string): PostContent {
  const lines = markdown.split('\n');
  const content: Array<Array<TextElement>> = [];
  let title = '';
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 处理代码块
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockContent = [];
      } else {
        inCodeBlock = false;
        // 添加代码块
        const codeText = codeBlockContent.join('\n');
        content.push([{
          tag: 'text',
          text: codeText,
          style: ['code']
        }]);
        codeBlockContent = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // 提取标题（仅第一个 # 标题作为消息标题）
    if (line.startsWith('# ') && !title) {
      title = line.slice(2).trim();
      continue;
    }

    // 处理其他标题级别（作为加粗文本）
    if (line.match(/^#{2,6}\s/)) {
      const headerText = line.replace(/^#+\s/, '').trim();
      const elements = parseInlineMarkdown(headerText);
      elements.forEach(el => {
        if (!el.style) el.style = [];
        el.style.push('bold');
      });
      content.push(elements);
      continue;
    }

    // 跳过空行
    if (!line.trim()) {
      continue;
    }

    // 处理列表项
    if (line.match(/^[\s]*[-*+]\s/) || line.match(/^[\s]*\d+\.\s/)) {
      const listText = line.replace(/^[\s]*[-*+\d.]+\s/, '').trim();
      const elements = parseInlineMarkdown(listText);
      // 添加列表标记
      elements.unshift({ tag: 'text', text: '• ' });
      content.push(elements);
      continue;
    }

    // 处理普通段落
    const elements = parseInlineMarkdown(line);
    if (elements.length > 0) {
      content.push(elements);
    }
  }

  // 如果没有提取到标题，使用传入的默认标题或空字符串
  if (!title) {
    title = defaultTitle ?? '';
  }

  return {
    zh_cn: {
      title,
      content
    }
  };
}

/**
 * 解析行内 Markdown 语法（粗体、斜体、代码、链接等）
 */
function parseInlineMarkdown(text: string): Array<TextElement> {
  const elements: Array<TextElement> = [];
  let currentPos = 0;

  // 匹配模式：粗体、斜体、删除线、行内代码、链接
  const patterns = [
    { regex: /\*\*\*(.+?)\*\*\*/g, styles: ['bold', 'italic'] },
    { regex: /\*\*(.+?)\*\*/g, styles: ['bold'] },
    { regex: /\*(.+?)\*/g, styles: ['italic'] },
    { regex: /__(.+?)__/g, styles: ['bold'] },
    { regex: /_(.+?)_/g, styles: ['italic'] },
    { regex: /~~(.+?)~~/g, styles: ['lineThrough'] },
    { regex: /`(.+?)`/g, styles: ['code'] },
    { regex: /\[([^\]]+)\]\(([^)]+)\)/g, isLink: true }
  ];

  // 找到所有匹配项及其位置
  interface Match {
    start: number;
    end: number;
    text: string;
    styles?: string[];
    isLink?: boolean;
    href?: string;
  }

  const matches: Match[] = [];

  patterns.forEach(pattern => {
    const regex = new RegExp(pattern.regex.source, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (pattern.isLink) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[1],
          isLink: true,
          href: match[2]
        });
      } else {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[1],
          styles: pattern.styles
        });
      }
    }
  });

  // 按位置排序
  matches.sort((a, b) => a.start - b.start);

  // 处理重叠的匹配（选择最长的）
  const filteredMatches: Match[] = [];
  for (const match of matches) {
    const overlaps = filteredMatches.some(
      m => (match.start >= m.start && match.start < m.end) ||
           (match.end > m.start && match.end <= m.end)
    );
    if (!overlaps) {
      filteredMatches.push(match);
    }
  }

  // 构建元素数组
  filteredMatches.forEach(match => {
    // 添加匹配前的普通文本
    if (match.start > currentPos) {
      const plainText = text.slice(currentPos, match.start);
      if (plainText) {
        elements.push({ tag: 'text', text: plainText });
      }
    }

    // 添加匹配的元素
    if (match.isLink) {
      elements.push({
        tag: 'a',
        text: match.text,
        href: match.href
      });
    } else {
      elements.push({
        tag: 'text',
        text: match.text,
        style: match.styles
      });
    }

    currentPos = match.end;
  });

  // 添加剩余的普通文本
  if (currentPos < text.length) {
    const plainText = text.slice(currentPos);
    if (plainText) {
      elements.push({ tag: 'text', text: plainText });
    }
  }

  // 如果没有任何匹配，返回整个文本
  if (elements.length === 0 && text) {
    elements.push({ tag: 'text', text });
  }

  return elements;
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
    /^[\s]*\d+\.\s/m        // 有序列表
  ];

  return markdownPatterns.some(pattern => pattern.test(text));
}
