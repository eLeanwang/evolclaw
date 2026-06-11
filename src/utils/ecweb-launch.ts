import fs from 'fs';
import path from 'path';
import { resolveGlobalPkg } from './npm-ops.js';
import { isWindows as platformIsWindows, resolveCommandPath } from './cross-platform.js';

const ECWEB_PKG = 'evolclaw-web';
const ECWEB_BIN = 'evolclaw-web';

export interface EcwebLaunchCommand {
  command: string;
  args: string[];
  entry?: string;
  source: 'package-bin' | 'command';
}

interface InstalledPackage {
  path: string;
}

interface ResolveEcwebLaunchOptions {
  installedPkg?: InstalledPackage | null;
  commandPath?: string | null;
  nodePath?: string;
  isWindows?: boolean;
}

function readEcwebPackageEntry(pkgJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[ECWEB_BIN];
    if (!bin) return null;

    const entry = path.resolve(path.dirname(pkgJsonPath), bin);
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function packageJsonBesideNpmShim(commandPath: string, isWindows: boolean): string | null {
  if (!isWindows || !/\.(cmd|bat)$/i.test(commandPath)) return null;

  const pkgJsonPath = path.join(path.dirname(commandPath), 'node_modules', ECWEB_PKG, 'package.json');
  return fs.existsSync(pkgJsonPath) ? pkgJsonPath : null;
}

/**
 * Resolve how to launch ecweb as a real background process.
 *
 * On Windows, npm bins are usually .cmd shims. Launching that shim through a
 * shell can create a visible console window; launching the package's JS entry
 * through the current Node executable avoids that wrapper entirely.
 */
export function resolveEcwebLaunchCommand(
  ecwebArgs: string[],
  opts: ResolveEcwebLaunchOptions = {},
): EcwebLaunchCommand | null {
  const nodePath = opts.nodePath ?? process.execPath;
  const installed = opts.installedPkg !== undefined ? opts.installedPkg : resolveGlobalPkg(ECWEB_PKG);

  let entry = installed?.path ? readEcwebPackageEntry(installed.path) : null;
  if (entry) {
    return { command: nodePath, args: [entry, ...ecwebArgs], entry, source: 'package-bin' };
  }

  const commandPath = opts.commandPath !== undefined ? opts.commandPath : resolveCommandPath(ECWEB_BIN);
  if (!commandPath) return null;

  const shimPkgJson = packageJsonBesideNpmShim(commandPath, opts.isWindows ?? platformIsWindows);
  entry = shimPkgJson ? readEcwebPackageEntry(shimPkgJson) : null;
  if (entry) {
    return { command: nodePath, args: [entry, ...ecwebArgs], entry, source: 'package-bin' };
  }

  return { command: commandPath, args: ecwebArgs, source: 'command' };
}
