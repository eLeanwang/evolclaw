import fs from 'fs';
import path from 'path';
import { resolveCommandPath } from '../utils/cross-platform.js';
import { getExistingHClassMaskTargets, isSameOrDescendant } from './protected-paths.js';
import { resolveRoot } from '../paths.js';

let cachedBubblewrapPath: string | null | undefined;

function isExecutableFile(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function codexBundledBubblewrap(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const codexPath = resolveCommandPath('codex');
  if (!codexPath) return undefined;

  let resolvedCodexPath = codexPath;
  try { resolvedCodexPath = fs.realpathSync(codexPath); } catch {}
  const packageRoot = resolvedCodexPath.endsWith(`${path.sep}bin${path.sep}codex.js`)
    ? path.resolve(path.dirname(resolvedCodexPath), '..')
    : undefined;
  if (!packageRoot) return undefined;

  const target = process.arch === 'arm64'
    ? 'aarch64-unknown-linux-musl'
    : 'x86_64-unknown-linux-musl';
  const platformPackage = process.arch === 'arm64' ? 'codex-linux-arm64' : 'codex-linux-x64';
  return path.join(
    packageRoot,
    'node_modules',
    '@openai',
    platformPackage,
    'vendor',
    target,
    'codex-resources',
    'bwrap',
  );
}

export function resolveBubblewrapPath(): string | undefined {
  if (cachedBubblewrapPath !== undefined) return cachedBubblewrapPath ?? undefined;
  if (process.platform !== 'linux') {
    cachedBubblewrapPath = null;
    return undefined;
  }

  const candidates = [
    process.env.EVOLCLAW_BWRAP_PATH,
    resolveCommandPath('bwrap') ?? undefined,
    codexBundledBubblewrap(),
  ];
  const resolved = candidates.find(isExecutableFile);
  cachedBubblewrapPath = resolved ?? null;
  return resolved;
}

export function prependExecutableDirectory(env: Record<string, string>, executablePath: string): Record<string, string> {
  const currentPath = env.PATH ?? process.env.PATH ?? '';
  const directory = path.dirname(executablePath);
  return {
    ...env,
    PATH: currentPath ? `${directory}${path.delimiter}${currentPath}` : directory,
  };
}

function pushWritableBind(args: string[], candidate: string): void {
  if (!fs.existsSync(candidate)) return;
  args.push('--bind', candidate, candidate);
}

function pushMaskedFile(args: string[], candidate: string): void {
  if (!fs.existsSync(candidate)) return;
  args.push('--ro-bind', '/dev/null', candidate);
}

function pushMaskedDirectory(args: string[], candidate: string): void {
  if (!fs.existsSync(candidate)) return;
  args.push('--tmpfs', candidate);
}

function appendRuntimeBackedEtcFiles(args: string[]): void {
  if (process.platform !== 'linux' || !fs.existsSync('/run')) return;

  let runtimeRoot = '/run';
  try { runtimeRoot = fs.realpathSync('/run'); } catch {}
  const createdDirectories = new Set<string>();

  for (const candidate of ['/etc/resolv.conf', '/etc/hosts', '/etc/hostname']) {
    let resolved: string;
    try { resolved = fs.realpathSync(candidate); } catch { continue; }
    if (resolved === runtimeRoot || !isSameOrDescendant(resolved, runtimeRoot)) continue;

    const directories: string[] = [];
    let current = path.dirname(resolved);
    while (current !== runtimeRoot && isSameOrDescendant(current, runtimeRoot)) {
      directories.push(current);
      current = path.dirname(current);
    }
    for (const directory of directories.reverse()) {
      if (createdDirectories.has(directory)) continue;
      createdDirectories.add(directory);
      args.push('--dir', directory);
    }

    // Bubblewrap opens bind sources before applying the new mount layout. This
    // preserves only the exact runtime-backed /etc file after /run is replaced,
    // without re-exposing sibling service or container-runtime sockets.
    args.push('--ro-bind', candidate, resolved);
  }
}

function appendHClassMasks(args: string[], root: string, maskContainerSockets: boolean): void {
  for (const target of getExistingHClassMaskTargets(root)) {
    if (target.kind === 'directory') pushMaskedDirectory(args, target.path);
    else pushMaskedFile(args, target.path);
  }
  if (!maskContainerSockets) return;
  // bubblewrap cannot replace an existing Unix socket with a regular-file bind
  // on all kernels. A private /run hides Docker, Podman, and user runtime
  // sockets without disabling ordinary network access needed by web tools.
  pushMaskedDirectory(args, '/run');
  appendRuntimeBackedEtcFiles(args);
}

export function buildHClassGuardCommand(
  executable: string,
  executableArgs: string[],
  root = resolveRoot(),
): { command: string; args: string[] } | undefined {
  const bubblewrapPath = resolveBubblewrapPath();
  if (!bubblewrapPath) return undefined;
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
  ];
  appendHClassMasks(args, path.resolve(root), true);
  args.push('--', executable, ...executableArgs);
  return { command: bubblewrapPath, args };
}

export function buildBubblewrapCommand(
  executable: string,
  executableArgs: string[],
  options: {
    projectPath: string;
    writablePaths?: string[];
    readonlyPaths?: string[];
    root?: string;
  },
): { command: string; args: string[] } | undefined {
  const bubblewrapPath = resolveBubblewrapPath();
  if (!bubblewrapPath) return undefined;

  const projectPath = path.resolve(options.projectPath);
  const root = path.resolve(options.root ?? resolveRoot());
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];

  pushWritableBind(args, projectPath);
  for (const writablePath of options.writablePaths ?? []) {
    const resolved = path.resolve(writablePath);
    if (isSameOrDescendant(resolved, projectPath)) continue;
    pushWritableBind(args, resolved);
  }
  for (const readonlyPath of options.readonlyPaths ?? []) {
    const resolved = path.resolve(readonlyPath);
    if (!fs.existsSync(resolved)) continue;
    args.push('--ro-bind', resolved, resolved);
  }

  appendHClassMasks(args, root, true);

  args.push('--chdir', projectPath, '--', executable, ...executableArgs);
  return { command: bubblewrapPath, args };
}

export function _resetSandboxRuntimeCache(): void {
  cachedBubblewrapPath = undefined;
}
