#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcEntry = path.join(repoRoot, 'src', 'cli', 'index.ts');
const distEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
const args = process.argv.slice(2);

if (fs.existsSync(srcEntry)) {
  try {
    const tsxImport = pathToFileURL(require.resolve('tsx')).href;
    const result = spawnSync(process.execPath, ['--import', tsxImport, srcEntry, ...args], { stdio: 'inherit' });
    process.exit(result.status ?? (result.error ? 1 : 0));
  } catch {}
}

if (fs.existsSync(distEntry)) {
  const result = spawnSync(process.execPath, [distEntry, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? (result.error ? 1 : 0));
}

console.error('ec: missing CLI entrypoint');
process.exit(1);
