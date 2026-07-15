import fs from 'fs';
import path from 'path';
import { resolveRoot } from '../paths.js';

const H_CLASS_RELATIVE_PATTERNS = [
  /^evolclaw\.json$/,
  /^config\.json$/,
  /^agents\/defaults\.json$/,
  /^agents\/[^/]+\/config\.json$/,
  /^agents\/[^/]+\/contact\.json$/,
  /^agents\/[^/]+\/relations\/[^/]+\/config\.json$/,
  /^backups\/config(?:\/|$)/,
  /^\.snapshots(?:\/|$)/,
  /^CA(?:\/|$)/,
  /^(?:AIDs|aids)\/[^/]+\/(?:cert|keys)(?:\/|$)/,
  /^\.device_id$/,
  /^\.env$/,
  /^\.seed(?:\.|$)/,
  /^\.migrated-/,
  /(?:^|\/)[^/]+\.json_$/,
  /(?:^|\/)[^/]+\.json\.migrated$/,
  /^agents\/defaults_\d+\.json$/,
  /^\.lock$/,
  /^daemon\.pid$/,
];

const H_CLASS_REFERENCE_PATTERNS = [
  /(?:^|[^A-Za-z0-9_.-])evolclaw\.json(?=$|[^A-Za-z0-9_.-])/,
  /(?:^|[^A-Za-z0-9_.-])agents[\\/](?:defaults\.json|[^/\\\s"']+[\\/](?:(?:config|contact)\.json|relations[\\/][^/\\\s"']+[\\/]config\.json))(?=$|[\s"';&|<>)},])/,
  /(?:^|[^A-Za-z0-9_.-])(?:backups[\\/]config|\.snapshots|CA|(?:AIDs|aids)[\\/][^/\\\s"']+[\\/](?:cert|keys))(?:[\\/]|$|[\s"';&|<>)},])/,
  /(?:^|[/\\\s"'=<>])(?:\.device_id|\.env|\.seed(?:\.[^/\\\s"']*)?|\.migrated-[^/\\\s"']*|\.lock|daemon\.pid)(?:[\\/]|$|[\s"';&|<>)},])/,
  /(?:^|[/\\\s"'=<>])(?:[^/\\\s"']+\.json_|[^/\\\s"']+\.json\.migrated|defaults_\d+\.json)(?=$|[\s"';&|<>)},])/,
];

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveThroughExistingAncestor(value: string): string {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let cursor = absolute;

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  try {
    return path.join(fs.realpathSync(cursor), ...missing);
  } catch {
    return absolute;
  }
}

export function isSameOrDescendant(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedParent = normalizeForComparison(parent);
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveProtectedCandidate(value: string, cwd = process.cwd()): string {
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  return resolveThroughExistingAncestor(absolute);
}

export function isHClassPath(
  value: string,
  options: { cwd?: string; root?: string } = {},
): boolean {
  const root = resolveThroughExistingAncestor(options.root ?? resolveRoot());
  const lexicalCandidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(options.cwd ?? process.cwd(), value);
  if (isSameOrDescendant(lexicalCandidate, root)) {
    const lexicalRelative = path.relative(root, lexicalCandidate).split(path.sep).join('/');
    if (H_CLASS_RELATIVE_PATTERNS.some(pattern => pattern.test(lexicalRelative))) return true;
  }
  const candidate = resolveProtectedCandidate(value, options.cwd);
  if (!isSameOrDescendant(candidate, root)) return false;
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  return H_CLASS_RELATIVE_PATTERNS.some(pattern => pattern.test(relative));
}

export function containsHClassReference(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  const unquoted = normalized.replace(/^["']|["']$/g, '').replace(/[;,) ]+$/, '');
  if (H_CLASS_RELATIVE_PATTERNS.some(pattern => pattern.test(unquoted))) return true;
  return H_CLASS_REFERENCE_PATTERNS.some(pattern => pattern.test(normalized));
}

export function getHClassSandboxPatterns(root = resolveRoot()): string[] {
  const absoluteRoot = resolveThroughExistingAncestor(root);
  const entries = [
    'evolclaw.json',
    'config.json',
    path.join('agents', 'defaults.json'),
    path.join('agents', '*', 'config.json'),
    path.join('agents', '*', 'contact.json'),
    path.join('agents', '*', 'relations', '*', 'config.json'),
    path.join('backups', 'config'),
    path.join('backups', 'config', '**'),
    '.snapshots',
    path.join('.snapshots', '**'),
    'CA',
    path.join('CA', '**'),
    path.join('AIDs', '*', 'cert'),
    path.join('AIDs', '*', 'cert', '**'),
    path.join('AIDs', '*', 'keys'),
    path.join('AIDs', '*', 'keys', '**'),
    path.join('aids', '*', 'cert'),
    path.join('aids', '*', 'cert', '**'),
    path.join('aids', '*', 'keys'),
    path.join('aids', '*', 'keys', '**'),
    '.device_id',
    '.env',
    '.seed',
    '.seed.*',
    '.migrated-*',
    path.join('**', '*.json_'),
    path.join('**', '*.json.migrated'),
    path.join('agents', 'defaults_*.json'),
    '.lock',
    'daemon.pid',
  ];
  return entries.map(entry => path.join(absoluteRoot, entry));
}

export interface HClassMaskTarget {
  path: string;
  kind: 'file' | 'directory';
}

function addExistingTarget(targets: Map<string, HClassMaskTarget>, value: string): void {
  try {
    const stat = fs.lstatSync(value);
    targets.set(path.resolve(value), {
      path: path.resolve(value),
      kind: stat.isDirectory() ? 'directory' : 'file',
    });
  } catch {}
}

export function getExistingHClassMaskTargets(root = resolveRoot()): HClassMaskTarget[] {
  const absoluteRoot = resolveThroughExistingAncestor(root);
  const targets = new Map<string, HClassMaskTarget>();
  for (const relative of [
    'evolclaw.json', 'config.json', 'backups/config', '.snapshots', 'CA',
    '.device_id', '.env', '.seed', '.lock', 'daemon.pid',
  ]) {
    addExistingTarget(targets, path.join(absoluteRoot, relative));
  }

  try {
    for (const entry of fs.readdirSync(absoluteRoot)) {
      if (entry.startsWith('.seed.') || entry.startsWith('.migrated-') || entry.endsWith('.json.migrated')) {
        addExistingTarget(targets, path.join(absoluteRoot, entry));
      }
    }
  } catch {}

  const agentsDir = path.join(absoluteRoot, 'agents');
  addExistingTarget(targets, path.join(agentsDir, 'defaults.json'));
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.name.match(/^defaults_\d+\.json$/) || entry.name.endsWith('.json_') || entry.name.endsWith('.json.migrated')) {
        addExistingTarget(targets, path.join(agentsDir, entry.name));
      }
      if (!entry.isDirectory()) continue;
      const agentRoot = path.join(agentsDir, entry.name);
      for (const fileName of ['config.json', 'config.json_', 'contact.json', 'contact.json_']) {
        addExistingTarget(targets, path.join(agentRoot, fileName));
      }
      const relationsDir = path.join(agentRoot, 'relations');
      try {
        for (const relation of fs.readdirSync(relationsDir, { withFileTypes: true })) {
          if (!relation.isDirectory()) continue;
          for (const fileName of ['config.json', 'config.json_']) {
            addExistingTarget(targets, path.join(relationsDir, relation.name, fileName));
          }
        }
      } catch {}
    }
  } catch {}

  for (const aidsName of ['AIDs', 'aids']) {
    const aidsRoot = path.join(absoluteRoot, aidsName);
    try {
      for (const aid of fs.readdirSync(aidsRoot, { withFileTypes: true })) {
        if (!aid.isDirectory()) continue;
        addExistingTarget(targets, path.join(aidsRoot, aid.name, 'cert'));
        addExistingTarget(targets, path.join(aidsRoot, aid.name, 'keys'));
      }
    } catch {}
  }
  return [...targets.values()];
}

export function buildCodexHClassFilesystemRules(root = resolveRoot()): Record<string, 'deny' | number> {
  return {
    // Codex pre-expands unbounded deny globs on Linux/WSL/Windows. Without a
    // bound, patterns such as **/*.json_ are accepted but may not be enforced.
    glob_scan_max_depth: 64,
    ...Object.fromEntries(getHClassSandboxPatterns(root).map(pattern => [pattern, 'deny'] as const)),
  };
}

export function hClassGrantIncludesProtectedPath(
  value: string,
  options: { cwd?: string; root?: string } = {},
): boolean {
  const root = resolveThroughExistingAncestor(options.root ?? resolveRoot());
  if (containsHClassReference(value)) return true;
  const normalized = value.replace(/\\/g, '/');
  const globIndex = normalized.search(/[*?[{]/);
  const literalGrantRoot = globIndex < 0
    ? value
    : normalized.slice(0, globIndex).replace(/\/+$/, '') || '.';
  const candidate = resolveProtectedCandidate(literalGrantRoot, options.cwd);
  if (isHClassPath(candidate, { root })) return true;
  if (isSameOrDescendant(root, candidate)) return true;
  if (!isSameOrDescendant(candidate, root)) return false;

  // A filesystem grant is a range, not a one-file allow. Every directory
  // below the protected root can contain an H-class backup name (for example
  // *.json_), so an overlay grant there could bypass the baseline deny rules.
  return true;
}

export function workspaceContainsHClassPaths(projectPath: string, root = resolveRoot()): boolean {
  const project = resolveThroughExistingAncestor(projectPath);
  const protectedRoot = resolveThroughExistingAncestor(root);
  if (isSameOrDescendant(protectedRoot, project)) return true;
  if (!isSameOrDescendant(project, protectedRoot)) return false;
  return hClassGrantIncludesProtectedPath(project, { root: protectedRoot });
}
