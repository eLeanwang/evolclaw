import { describe, it, expect } from 'vitest';

describe('markdownToPlainText', () => {
  async function convert(text: string) {
    const { markdownToPlainText } = await import('../../src/utils/format.js');
    return markdownToPlainText(text);
  }

  it('should strip code fences', async () => {
    expect(await convert('```js\nconsole.log("hi")\n```')).toBe('console.log("hi")');
  });

  it('should strip bold and italic', async () => {
    expect(await convert('**bold** and *italic*')).toBe('bold and italic');
  });

  it('should strip headers', async () => {
    expect(await convert('## Title\ntext')).toBe('Title\ntext');
  });

  it('should strip inline code', async () => {
    expect(await convert('use `foo()` here')).toBe('use foo() here');
  });

  it('should keep link text, remove URL', async () => {
    expect(await convert('[click here](https://example.com)')).toBe('click here');
  });

  it('should remove images', async () => {
    expect(await convert('![alt](https://img.png)')).toBe('');
  });

  it('should strip list markers', async () => {
    expect(await convert('- item1\n- item2')).toBe('item1\nitem2');
  });

  it('should strip blockquotes', async () => {
    expect(await convert('> quoted text')).toBe('quoted text');
  });

  it('should handle empty string', async () => {
    expect(await convert('')).toBe('');
  });
});
