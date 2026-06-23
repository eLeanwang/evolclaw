import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ProjectPathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  existsSync?: (candidate: string) => boolean;
}

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function trimTrailingSeparators(value: string, root: string): string {
  let out = value;
  while (out.length > root.length && /[\\/]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

function normalizeForCompare(value: string, platform: NodeJS.Platform): string {
  const pathImpl = pathForPlatform(platform);
  const resolved = pathImpl.resolve(value);
  const trimmed = trimTrailingSeparators(resolved, pathImpl.parse(resolved).root);
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function isWindowsUnsafeProjectRoot(rootPath: string, homeDir: string): boolean {
  const win = path.win32;
  const root = normalizeForCompare(rootPath, 'win32');
  const parsed = win.parse(win.resolve(rootPath));
  if (root === normalizeForCompare(parsed.root, 'win32')) return true;

  const userProfileRoot = win.dirname(win.resolve(homeDir));
  if (win.basename(userProfileRoot).toLowerCase() !== 'users') return false;
  return root === normalizeForCompare(userProfileRoot, 'win32');
}

export function sanitizeProjectRoot(rootPath: string, options: ProjectPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return rootPath;

  const homeDir = options.homeDir ?? os.homedir();
  if (!homeDir) return rootPath;
  return isWindowsUnsafeProjectRoot(rootPath, homeDir)
    ? path.win32.join(homeDir, 'Projects')
    : rootPath;
}

export function defaultProjectsRoot(evolclawRoot: string, options: ProjectPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const pathImpl = pathForPlatform(platform);

  if (platform === 'win32') {
    const homeDir = options.homeDir ?? os.homedir();
    if (homeDir && isWindowsUnsafeProjectRoot(evolclawRoot, homeDir)) {
      return path.win32.join(homeDir, 'Projects');
    }
  }

  return pathImpl.join(evolclawRoot, 'projects');
}

export function agentProjectRootFromDefaults(
  defaults: { projects?: { rootPath?: string; defaultPath?: string } } | null | undefined,
  evolclawRoot: string,
  options: ProjectPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const pathImpl = pathForPlatform(platform);
  const configuredRoot = defaults?.projects?.rootPath
    || (defaults?.projects?.defaultPath && pathImpl.dirname(defaults.projects.defaultPath))
    || defaultProjectsRoot(evolclawRoot, options);
  return sanitizeProjectRoot(configuredRoot, options);
}

export function deriveAgentProjectPath(
  rootPath: string,
  aid: string,
  options: ProjectPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const pathImpl = pathForPlatform(platform);
  const existsSync = options.existsSync ?? fs.existsSync;
  const baseName = aid.split('.')[0];
  const safeRootPath = sanitizeProjectRoot(rootPath, options);
  let candidate = pathImpl.join(safeRootPath, baseName);
  if (!existsSync(candidate)) return candidate;
  let i = 1;
  while (existsSync(`${candidate}~${i}`)) i++;
  return `${candidate}~${i}`;
}
