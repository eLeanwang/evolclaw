import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// node:sqlite 不在 builtinModules 中（太新），Vite 无法识别，需要手动处理
function nodeSqlitePlugin(): Plugin {
  return {
    name: 'node-sqlite-external',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'node:sqlite' || source === 'sqlite') {
        return { id: '\0node:sqlite', external: false };
      }
    },
    load(id) {
      if (id === '\0node:sqlite') {
        return `
          import { createRequire } from 'node:module';
          const require = createRequire(import.meta.url);
          const mod = require('node:sqlite');
          export const DatabaseSync = mod.DatabaseSync;
          export const StatementSync = mod.StatementSync;
          export const backup = mod.backup;
          export const constants = mod.constants;
        `;
      }
    },
  };
}

export default defineConfig({
  plugins: [nodeSqlitePlugin()],
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
