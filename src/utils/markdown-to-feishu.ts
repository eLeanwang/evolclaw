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
 * 将 Markdown 文本转换为飞书 post 消息格式
 * 利用 md tag 让飞书原生渲染，支持代码高亮、嵌套列表、引用等全部语法
 */
export function markdownToFeishuPost(markdown: string, defaultTitle?: string): PostContent {
  const match = markdown.match(/^# (.+)$/m);
  const title = match?.[1] ?? defaultTitle ?? '';
  const body = match ? markdown.replace(/^# .+\n?/, '') : markdown;

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
    /^[\s]*\d+\.\s/m        // 有序列表
  ];

  return markdownPatterns.some(pattern => pattern.test(text));
}
