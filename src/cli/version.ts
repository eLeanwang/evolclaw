/**
 * ec version — 显示所有组件版本和构建时间戳，便于诊断。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN  = '\x1b[36m';

interface PkgInfo {
  name: string;
  version: string;
  buildTs?: string;
  path: string;
}

function readPkgJson(dir: string): { name?: string; version?: string } | null {
  const f = path.join(dir, 'package.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}

function getFileModTime(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString().replace('T', ' ').slice(0, 19);
  } catch { return null; }
}

function findInstalledVersion(pkgName: string): PkgInfo | null {
  // 从 PACKAGE_ROOT/node_modules 查找
  const dir = path.join(PACKAGE_ROOT, 'node_modules', ...pkgName.split('/'));
  const pkg = readPkgJson(dir);
  if (!pkg) return null;
  // 取 dist/index.js 修改时间作为构建时间戳参考
  const mainFile = path.join(dir, 'dist', 'index.js');
  const ts = getFileModTime(mainFile) || getFileModTime(path.join(dir, 'index.js'));
  return { name: pkg.name || pkgName, version: pkg.version || '?', buildTs: ts || undefined, path: dir };
}

export function handleVersion(args: string[]): void {
  const isJson = args.includes('--format') && args.includes('json') || args.includes('--json');

  // 主包
  const mainPkg = readPkgJson(PACKAGE_ROOT);
  const mainEntry = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
  const mainTs = getFileModTime(mainEntry);

  // ecweb 包
  const ecwebDir = path.join(PACKAGE_ROOT, 'ecweb');
  const ecwebPkg = readPkgJson(ecwebDir);
  const ecwebEntry = path.join(ecwebDir, 'dist', 'index.js');
  const ecwebTs = getFileModTime(ecwebEntry);
  const ecwebStaticTs = getFileModTime(path.join(ecwebDir, 'dist', 'static', 'index.html'));

  // 关键依赖
  const deps = [
    '@agentunion/fastaun',
    'ws',
  ];

  const components: Array<{ name: string; version: string; built?: string; note?: string }> = [
    { name: 'evolclaw', version: mainPkg?.version || '?', built: mainTs || undefined, note: 'main package' },
    { name: 'evolclaw-web', version: ecwebPkg?.version || '?', built: ecwebTs || undefined, note: `static: ${ecwebStaticTs || '?'}` },
  ];

  for (const dep of deps) {
    const info = findInstalledVersion(dep);
    if (info) {
      components.push({ name: info.name, version: info.version, built: info.buildTs || undefined });
    }
  }

  // Node.js 版本
  components.push({ name: 'node', version: process.version, note: process.platform + '/' + process.arch });

  if (isJson) {
    console.log(JSON.stringify(components, null, 2));
    return;
  }

  console.log(`\n${BOLD}🔧 EvolClaw Component Versions${RESET}\n`);
  const nameW = Math.max(...components.map(c => c.name.length), 8);
  const verW = Math.max(...components.map(c => c.version.length), 7);
  for (const c of components) {
    const builtStr = c.built ? `${DIM}built: ${c.built}${RESET}` : '';
    const noteStr = c.note ? `${DIM}(${c.note})${RESET}` : '';
    console.log(`  ${CYAN}${c.name.padEnd(nameW)}${RESET}  ${GREEN}${c.version.padEnd(verW)}${RESET}  ${builtStr} ${noteStr}`);
  }
  console.log();
}
