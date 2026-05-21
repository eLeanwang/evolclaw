import fs from 'fs';
import path from 'path';
import { kitsRulesDir } from '../paths.js';

let _cachedRules: string | null = null;

export function loadRulesForInjection(): string {
  if (_cachedRules !== null) return _cachedRules;

  const rulesDir = kitsRulesDir();
  if (!fs.existsSync(rulesDir)) {
    _cachedRules = '';
    return '';
  }

  const files = fs.readdirSync(rulesDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(fs.readFileSync(path.join(rulesDir, file), 'utf-8'));
    } catch { /* skip unreadable files */ }
  }

  _cachedRules = parts.join('\n\n');
  return _cachedRules;
}

export function invalidateRulesCache(): void {
  _cachedRules = null;
}
