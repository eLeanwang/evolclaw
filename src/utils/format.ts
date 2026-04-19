// ── Markdown → Plain Text ───────────────────────────────────────────────────

export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Tables: remove separator rows
  result = result.replace(/^\|[\s:|-]+\|$/gm, '');
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split('|').map(cell => cell.trim()).join('  ')
  );
  // Bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '$1');
  // Inline code
  result = result.replace(/`([^`]+)`/g, '$1');
  // Headers
  result = result.replace(/^#{1,6}\s+/gm, '');
  // Blockquotes
  result = result.replace(/^>\s?/gm, '');
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '');
  // List markers
  result = result.replace(/^(\s*)[-*+]\s/gm, '$1');
  result = result.replace(/^(\s*)\d+\.\s/gm, '$1');
  return result.trim();
}
