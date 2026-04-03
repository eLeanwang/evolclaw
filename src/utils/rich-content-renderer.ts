/**
 * Rich Content Renderer
 *
 * Renders LaTeX formulas and Mermaid diagrams to PNG images using Playwright.
 * KaTeX CSS/JS/fonts and Mermaid JS are loaded from node_modules and injected
 * inline via setContent — no network, CDN, or local server needed.
 */

import fs from 'fs';
import path from 'path';
import { getPackageRoot } from '../paths.js';
import { logger } from './logger.js';

// Lazy-loaded Playwright
let chromium: any;
let browserInstance: any;
let browserContext: any;

// Cached inline resources (loaded once, reused)
let katexCSS: string | null = null;
let katexJS: string | null = null;
let mermaidJS: string | null = null;

function getKatexCSS(): string {
  if (katexCSS) return katexCSS;
  const katexDir = path.join(getPackageRoot(), 'node_modules', 'katex', 'dist');
  let css = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8');
  // Embed woff2 fonts as data URIs so they work without file:// or http
  css = css.replace(/url\(fonts\/([\w.-]+\.woff2)\)/g, (_m: string, fontFile: string) => {
    const fontPath = path.join(katexDir, 'fonts', fontFile);
    if (fs.existsSync(fontPath)) {
      const b64 = fs.readFileSync(fontPath).toString('base64');
      return `url(data:font/woff2;base64,${b64})`;
    }
    return _m;
  });
  katexCSS = css;
  return css;
}

function getKatexJS(): string {
  if (katexJS) return katexJS;
  const katexDir = path.join(getPackageRoot(), 'node_modules', 'katex', 'dist');
  katexJS = fs.readFileSync(path.join(katexDir, 'katex.min.js'), 'utf8');
  return katexJS;
}

function getMermaidJS(): string {
  if (mermaidJS) return mermaidJS;
  const mermaidDir = path.join(getPackageRoot(), 'node_modules', 'mermaid', 'dist');
  mermaidJS = fs.readFileSync(path.join(mermaidDir, 'mermaid.min.js'), 'utf8');
  return mermaidJS;
}

async function getBrowser(): Promise<any> {
  if (browserInstance?.isConnected?.()) return browserInstance;

  try {
    // @ts-ignore - runtime path, not a declared module
    const pw = await import('/root/.claude/node_modules/playwright/index.mjs');
    chromium = pw.chromium;
  } catch {
    // @ts-ignore - optional dependency
    const pw = await import('playwright');
    chromium = pw.chromium;
  }

  browserInstance = await chromium.launch({
    headless: false,
    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  browserContext = await browserInstance.newContext({
    viewport: { width: 1280, height: 800 },
  });
  return browserInstance;
}

async function getPage(): Promise<any> {
  await getBrowser();
  return browserContext.newPage();
}

export async function renderLatex(formula: string, displayMode = true): Promise<Buffer> {
  const page = await getPage();
  try {
    const css = getKatexCSS();
    const js = getKatexJS();
    const escaped = formula.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

    const html = '<!DOCTYPE html><html><head><style>' + css + '</style>'
      + '<style>body{background:white;margin:0;padding:16px;display:inline-block;}#f{font-size:1.2em;}</style>'
      + '</head><body><div id="f"></div>'
      + '<scr' + 'ipt>' + js + '</scr' + 'ipt>'
      + '<scr' + 'ipt>'
      + 'try{katex.render("' + escaped + '",document.getElementById("f"),'
      + '{displayMode:' + displayMode + ',throwOnError:false});'
      + '}catch(e){document.getElementById("f").textContent="Error: "+e.message;}'
      + '</scr' + 'ipt></body></html>';

    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(500);

    const el = page.locator('#f');
    const box = await el.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error('LaTeX element has zero size');
    }
    return Buffer.from(await el.screenshot({ type: 'png' }));
  } finally {
    await page.close();
  }
}

export async function renderMermaid(code: string): Promise<Buffer> {
  const page = await getPage();
  try {
    const js = getMermaidJS();
    const escaped = code.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

    const html = '<!DOCTYPE html><html><head>'
      + '<style>body{background:white;margin:0;padding:16px;display:inline-block;}</style>'
      + '</head><body><div id="m"></div>'
      + '<scr' + 'ipt>' + js + '</scr' + 'ipt>'
      + '<scr' + 'ipt>'
      + '(async()=>{'
      + 'mermaid.initialize({startOnLoad:false,theme:"default"});'
      + 'try{const{svg}=await mermaid.render("md",`' + escaped + '`);'
      + 'document.getElementById("m").innerHTML=svg;'
      + '}catch(e){document.getElementById("m").textContent="Error: "+e.message;}'
      + '})();'
      + '</scr' + 'ipt></body></html>';

    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const el = page.locator('#m');
    const box = await el.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error('Mermaid element has zero size');
    }
    return Buffer.from(await el.screenshot({ type: 'png' }));
  } finally {
    await page.close();
  }
}

export function extractLatex(text: string): Array<{
  match: string; formula: string; displayMode: boolean; start: number; end: number;
}> {
  const results: Array<{
    match: string; formula: string; displayMode: boolean; start: number; end: number;
  }> = [];

  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    results.push({
      match: m[0], formula: m[1].trim(), displayMode: true,
      start: m.index, end: m.index + m[0].length,
    });
  }

  const inlineRe = /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g;
  while ((m = inlineRe.exec(text)) !== null) {
    const overlaps = results.some(r => m!.index >= r.start && m!.index < r.end);
    if (!overlaps) {
      results.push({
        match: m[0], formula: m[1].trim(), displayMode: false,
        start: m.index, end: m.index + m[0].length,
      });
    }
  }

  results.sort((a, b) => a.start - b.start);
  return results;
}

export function extractMermaid(text: string): Array<{
  match: string; code: string; start: number; end: number;
}> {
  const results: Array<{ match: string; code: string; start: number; end: number; }> = [];
  const re = /```mermaid\s*\n([\s\S]+?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push({ match: m[0], code: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  return results;
}

export async function renderAllRichContent(text: string): Promise<Array<{
  match: string; start: number; end: number; type: 'latex' | 'mermaid'; png: Buffer;
}>> {
  const latexItems = extractLatex(text);
  const mermaidItems = extractMermaid(text);
  const results: Array<{
    match: string; start: number; end: number; type: 'latex' | 'mermaid'; png: Buffer;
  }> = [];

  for (const item of latexItems) {
    try {
      const png = await renderLatex(item.formula, item.displayMode);
      results.push({ match: item.match, start: item.start, end: item.end, type: 'latex', png });
    } catch (err) {
      logger.warn('[RichContent] LaTeX render failed: ' + item.formula, err);
    }
  }

  for (const item of mermaidItems) {
    try {
      const png = await renderMermaid(item.code);
      results.push({ match: item.match, start: item.start, end: item.end, type: 'mermaid', png });
    } catch (err) {
      logger.warn('[RichContent] Mermaid render failed', err);
    }
  }

  return results;
}

export function hasRichContent(text: string): boolean {
  return extractLatex(text).length > 0 || extractMermaid(text).length > 0;
}

export async function closeBrowser(): Promise<void> {
  if (browserContext) { await browserContext.close().catch(() => {}); browserContext = null; }
  if (browserInstance) { await browserInstance.close().catch(() => {}); browserInstance = null; }
}
