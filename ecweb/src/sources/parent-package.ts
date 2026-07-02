import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

let packageRootCache: string | null = null;

function isEvolclawPackageRoot(dir: string): boolean {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg?.name === 'evolclaw';
  } catch {
    return false;
  }
}

function findUp(start: string): string | null {
  let dir = path.resolve(start);

  while (true) {
    if (isEvolclawPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function candidateStarts(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const starts = [
    process.env.EVOLCLAW_PACKAGE_ROOT,
    here,
    process.cwd(),
    process.argv[1] ? path.dirname(process.argv[1]) : undefined,
  ];

  return [...new Set(starts.filter((item): item is string => !!item))];
}

export function resolveEvolclawPackageRoot(): string {
  if (packageRootCache) return packageRootCache;

  const searched: string[] = [];
  for (const start of candidateStarts()) {
    searched.push(start);
    const root = findUp(start);
    if (root) {
      packageRootCache = root;
      return root;
    }
  }

  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('evolclaw/package.json');
    const root = path.dirname(pkgJson);
    if (isEvolclawPackageRoot(root)) {
      packageRootCache = root;
      return root;
    }
  } catch {
    // Fall through to a diagnostic error.
  }

  throw new Error(`EvolClaw package root not found. searched=${searched.join(', ')}`);
}

export function resolveParentDistModule(...segments: string[]): string {
  const root = resolveEvolclawPackageRoot();
  const modulePath = path.join(root, 'dist', ...segments);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`EvolClaw dist module not found: ${modulePath}. Run npm run build in ${root}.`);
  }
  return modulePath;
}

export function toFileUrl(p: string): string {
  return process.platform === 'win32'
    ? new URL('file:///' + p.replace(/\\/g, '/')).href
    : p;
}
