import fs from 'fs';
import path from 'path';
import { getPackageRoot, resolveRoot } from '../paths.js';
import { logger } from '../utils/logger.js';

export type PromptSection = 'runtime' | 'group' | 'proactive';

const KNOWN_SECTIONS: Set<string> = new Set(['runtime', 'group', 'proactive']);

const SECTION_RE = /^##\s+(\w+)\s*$/;

let sections: Map<PromptSection, string> | null = null;
let builtinSections: Map<PromptSection, string> | null = null;

function parseTemplate(content: string): Map<PromptSection, string> {
  const result = new Map<PromptSection, string>();
  let currentSection: PromptSection | null = null;
  let currentLines: string[] = [];

  for (const line of content.split('\n')) {
    // Stop parsing at horizontal rule separator (documentation follows)
    if (/^---\s*$/.test(line)) {
      if (currentSection) {
        result.set(currentSection, currentLines.join('\n').trim());
      }
      break;
    }
    const m = line.match(SECTION_RE);
    if (m) {
      if (currentSection) {
        result.set(currentSection, currentLines.join('\n').trim());
      }
      const name = m[1];
      if (KNOWN_SECTIONS.has(name)) {
        currentSection = name as PromptSection;
        currentLines = [];
      } else {
        currentSection = null;
        currentLines = [];
      }
    } else if (currentSection) {
      currentLines.push(line);
    }
  }
  if (currentSection) {
    result.set(currentSection, currentLines.join('\n').trim());
  }
  return result;
}

function loadBuiltinTemplate(): Map<PromptSection, string> {
  const builtinPath = path.join(getPackageRoot(), 'dist', 'templates', 'prompts.md');
  const srcPath = path.join(getPackageRoot(), 'src', 'templates', 'prompts.md');
  const filePath = fs.existsSync(builtinPath) ? builtinPath : srcPath;
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseTemplate(content);
}

export function loadPromptTemplates(): void {
  builtinSections = loadBuiltinTemplate();

  const userPath = path.join(resolveRoot(), 'data', 'prompts.md');
  if (fs.existsSync(userPath)) {
    try {
      const content = fs.readFileSync(userPath, 'utf-8');
      const parsed = parseTemplate(content);
      sections = new Map(builtinSections);
      for (const [key, value] of parsed) {
        sections.set(key, value);
      }
      logger.info(`[PromptTemplates] Loaded user override: ${userPath}`);
    } catch (err) {
      logger.warn(`[PromptTemplates] Failed to load user override (${userPath}), using builtin:`, err);
      sections = builtinSections;
    }
  } else {
    sections = builtinSections;
    logger.info(`[PromptTemplates] Using builtin templates`);
  }

  for (const name of KNOWN_SECTIONS) {
    if (!sections.has(name as PromptSection)) {
      logger.warn(`[PromptTemplates] Section "${name}" missing, using builtin fallback`);
      const fallback = builtinSections.get(name as PromptSection);
      if (fallback) sections.set(name as PromptSection, fallback);
    }
  }
}

type VarValue = string | boolean | number | undefined | null;

function isTruthy(val: VarValue): boolean {
  if (val === undefined || val === null || val === false || val === '' || val === 0) return false;
  return true;
}

function renderTemplate(template: string, vars: Record<string, VarValue>): string {
  // Pass 1: conditional sections {{?key}}...{{/}}
  let result = template.replace(/\{\{\?(\w+)\}\}([\s\S]*?)\{\{\/\}\}/g, (_match, key, body) => {
    return isTruthy(vars[key]) ? body : '';
  });

  // Pass 2: variable substitution {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const val = vars[key];
    if (!isTruthy(val)) return '';
    return String(val);
  });

  // Pass 3: remove blank lines
  return result.split('\n').filter(line => line.trim() !== '').join('\n');
}

export function renderPromptSection(
  section: PromptSection,
  vars: Record<string, VarValue>
): string {
  if (!sections) loadPromptTemplates();
  const template = sections!.get(section);
  if (!template) {
    logger.warn(`[PromptTemplates] Section "${section}" not found`);
    return '';
  }
  return renderTemplate(template, vars);
}

/** Reset loaded templates (for testing) */
export function _resetTemplates(): void {
  sections = null;
  builtinSections = null;
}

/** Load templates from a raw string (for testing) */
export function _loadFromString(content: string): void {
  builtinSections = parseTemplate(content);
  sections = builtinSections;
}
