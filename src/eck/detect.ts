import fs from 'fs';
import path from 'path';
import { BASEAGENT_CAPS } from './baseagent-caps.js';

const MAX_DEPTH = 5;

export function resolveEckInjection(
  agentConfig: { baseAgent: string },
  projectPath: string,
  kitsRulesPath: string
): { shouldInject: boolean; reason: string } {
  const caps = BASEAGENT_CAPS[agentConfig.baseAgent]
    ?? { autoLoadsRules: false, supportsSystemPrompt: true };

  if (!caps.autoLoadsRules) {
    return { shouldInject: true, reason: 'baseagent-no-autoload' };
  }

  const symlinkActive = detectEckSymlink(projectPath, kitsRulesPath);
  if (symlinkActive) {
    return { shouldInject: false, reason: 'symlink-active' };
  }

  return { shouldInject: true, reason: 'symlink-not-found' };
}

export function detectEckSymlink(projectPath: string, kitsRulesPath: string): boolean {
  let dir = projectPath;
  let depth = 0;
  while (depth < MAX_DEPTH) {
    const eckDir = path.join(dir, '.claude', 'rules', 'eck');
    if (fs.existsSync(eckDir)) {
      try {
        const realPath = fs.realpathSync(eckDir);
        const kitsRulesReal = fs.realpathSync(kitsRulesPath);
        if (pathEquals(realPath, kitsRulesReal)) {
          return true;
        }
      } catch {
        // detection failure → conservatively assume not loaded
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }
  return false;
}

function pathEquals(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
  return path.resolve(a) === path.resolve(b);
}
