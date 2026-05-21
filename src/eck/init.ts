import fs from 'fs';
import path from 'path';
import { resolvePaths, kitsDocsDir, agentDir, getPackageRoot } from '../paths.js';
import { atomicWriteText } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export function initEck(): void {
  const p = resolvePaths();
  const eckDir = p.eckDir;
  fs.mkdirSync(eckDir, { recursive: true });

  initEckRuntime(eckDir);
  initEckPathRegistry(eckDir);
}

export function initAgentIndex(aid: string): void {
  const indexDir = path.join(agentDir(aid), 'index');
  fs.mkdirSync(indexDir, { recursive: true });

  const indexFile = path.join(indexDir, 'INDEX.md');
  const guideFile = path.join(indexDir, 'GUIDE.md');

  if (!fs.existsSync(indexFile)) {
    const template = loadTemplate('INDEX.template.md');
    if (template) {
      atomicWriteText(indexFile, renderTemplate(template, { AID: aid }));
      logger.info(`[eck] Created ${indexFile}`);
    }
  }

  if (!fs.existsSync(guideFile)) {
    const template = loadTemplate('GUIDE.template.md');
    if (template) {
      atomicWriteText(guideFile, renderTemplate(template, { AID: aid }));
      logger.info(`[eck] Created ${guideFile}`);
    }
  }
}

function initEckRuntime(eckDir: string): void {
  const runtimeFile = path.join(eckDir, 'runtime.md');
  if (fs.existsSync(runtimeFile)) return;

  const template = loadTemplate('runtime.template.md');
  if (!template) return;

  const vars: Record<string, string> = {
    EVOLCLAW_HOME: resolvePaths().root,
    PACKAGE_ROOT: getPackageRoot(),
  };

  atomicWriteText(runtimeFile, renderTemplate(template, vars));
  logger.info(`[eck] Created ${runtimeFile}`);
}

function initEckPathRegistry(eckDir: string): void {
  const registryFile = path.join(eckDir, 'path-registry.md');
  if (fs.existsSync(registryFile)) return;

  const template = loadTemplate('path-registry.template.md');
  if (!template) return;

  const vars: Record<string, string> = {
    EVOLCLAW_HOME: resolvePaths().root,
    PACKAGE_ROOT: getPackageRoot(),
  };

  atomicWriteText(registryFile, renderTemplate(template, vars));
  logger.info(`[eck] Created ${registryFile}`);
}

function loadTemplate(filename: string): string | null {
  const templatePath = path.join(kitsDocsDir(), 'eck_templates', filename);
  try {
    return fs.readFileSync(templatePath, 'utf-8');
  } catch {
    logger.warn(`[eck] Template not found: ${templatePath}`);
    return null;
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
