import { describe, it, expect, afterAll } from 'vitest';
import {
  extractLatex,
  extractMermaid,
  hasRichContent,
  renderLatex,
  renderMermaid,
  closeBrowser,
} from '../../src/utils/rich-content-renderer.js';

describe('rich-content-renderer', () => {
  describe('extractLatex', () => {
    it('should extract block formulas', () => {
      const results = extractLatex('Text $$E=mc^2$$ more');
      expect(results).toHaveLength(1);
      expect(results[0].formula).toBe('E=mc^2');
      expect(results[0].displayMode).toBe(true);
    });

    it('should extract inline formulas', () => {
      const results = extractLatex('Inline $x^2$ here');
      expect(results).toHaveLength(1);
      expect(results[0].formula).toBe('x^2');
      expect(results[0].displayMode).toBe(false);
    });

    it('should extract both block and inline', () => {
      const results = extractLatex('$a+b$ and $$\\frac{a}{b}$$ end');
      expect(results).toHaveLength(2);
      expect(results[0].displayMode).toBe(false);
      expect(results[1].displayMode).toBe(true);
    });

    it('should not match $$ as inline', () => {
      const results = extractLatex('$$E=mc^2$$');
      expect(results).toHaveLength(1);
      expect(results[0].displayMode).toBe(true);
    });

    it('should handle multiline block formulas', () => {
      const results = extractLatex('$$\n\\frac{a}{b}\n+ c\n$$');
      expect(results).toHaveLength(1);
      expect(results[0].formula).toBe('\\frac{a}{b}\n+ c');
    });

    it('should handle complex LaTeX from real output', () => {
      const text = '$$\\boxed{\\Phi = 5.311 \\times 10^7}$$';
      const results = extractLatex(text);
      expect(results).toHaveLength(1);
      expect(results[0].formula).toContain('\\boxed');
    });
  });

  describe('extractMermaid', () => {
    it('should extract mermaid code blocks', () => {
      const text = 'Text\n```mermaid\ngraph TD\n  A --> B\n```\nMore';
      const results = extractMermaid(text);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('graph TD\n  A --> B');
    });

    it('should extract multiple mermaid blocks', () => {
      const text = '```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: msg\n```';
      expect(extractMermaid(text)).toHaveLength(2);
    });

    it('should not match non-mermaid code blocks', () => {
      expect(extractMermaid('```javascript\nconst x = 1;\n```')).toHaveLength(0);
    });
  });

  describe('hasRichContent', () => {
    it('should detect LaTeX', () => {
      expect(hasRichContent('$$E=mc^2$$')).toBe(true);
    });

    it('should detect Mermaid', () => {
      expect(hasRichContent('```mermaid\ngraph TD\n```')).toBe(true);
    });

    it('should return false for plain text', () => {
      expect(hasRichContent('Just plain text')).toBe(false);
    });
  });

  // Rendering tests need Playwright + browser + katex/mermaid
  const hasKatex = (() => { try { require.resolve('katex'); return true; } catch { return false; } })();
  const hasMermaid = (() => { try { require.resolve('mermaid'); return true; } catch { return false; } })();

  describe.skipIf(!hasKatex)('renderLatex', () => {
    afterAll(async () => { await closeBrowser(); });

    it('should render E=mc^2 to PNG', async () => {
      const png = await renderLatex('E=mc^2', true);
      expect(png).toBeInstanceOf(Buffer);
      expect(png.length).toBeGreaterThan(100);
      // PNG magic bytes: 0x89 P N G
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4E);
      expect(png[3]).toBe(0x47);
    }, 30000);

    it('should render inline formula', async () => {
      const png = await renderLatex('x^2 + y^2 = z^2', false);
      expect(png).toBeInstanceOf(Buffer);
      expect(png.length).toBeGreaterThan(100);
    }, 30000);

    it('should render complex formula with fractions', async () => {
      const png = await renderLatex(
        '\\frac{\\partial f}{\\partial x} = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}',
        true
      );
      expect(png).toBeInstanceOf(Buffer);
      expect(png.length).toBeGreaterThan(100);
    }, 30000);
  });

  describe.skipIf(!hasMermaid)('renderMermaid', () => {
    afterAll(async () => { await closeBrowser(); });

    it('should render a flowchart to PNG', async () => {
      const png = await renderMermaid('graph TD\n  A[Start] --> B[End]');
      expect(png).toBeInstanceOf(Buffer);
      expect(png.length).toBeGreaterThan(100);
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
    }, 30000);

    it('should render a sequence diagram', async () => {
      const png = await renderMermaid('sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi');
      expect(png).toBeInstanceOf(Buffer);
      expect(png.length).toBeGreaterThan(100);
    }, 30000);
  });
});
