import { afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _resetRoot } from '../src/paths.js';
import { _resetSchemaCache } from '../src/config/schema-registry.js';
import { closeStatsDb } from '../src/stats/db.js';

let testHome: string | undefined;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-test-'));
  process.env.EVOLCLAW_HOME = testHome;
  _resetRoot();
  _resetSchemaCache();
});

afterEach(() => {
  closeStatsDb();
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  _resetSchemaCache();
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});
