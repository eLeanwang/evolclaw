#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const agentsDir = join(homedir(), '.evolclaw', 'agents');
const dirs = readdirSync(agentsDir).filter(name => name.endsWith('.agentid.pub'));

const stats = { total: 0, fixed: 0, skipped: 0, errors: [] };

for (const dir of dirs) {
  const configPath = join(agentsDir, dir, 'config.json');
  stats.total++;

  try {
    const stat = statSync(configPath);
    if (!stat.isFile()) {
      stats.skipped++;
      continue;
    }

    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);

    // 检查是否已有 roles.defaultRoles
    if (config.roles?.defaultRoles?.private && config.roles?.defaultRoles?.group) {
      console.log(`[SKIP] ${dir} - already has defaultRoles`);
      stats.skipped++;
      continue;
    }

    // 添加或补全 roles.defaultRoles
    if (!config.roles) {
      config.roles = {};
    }
    if (!config.roles.defaultRoles) {
      config.roles.defaultRoles = {};
    }
    if (!config.roles.defaultRoles.private) {
      config.roles.defaultRoles.private = 'member';
    }
    if (!config.roles.defaultRoles.group) {
      config.roles.defaultRoles.group = 'member';
    }

    // 写回（保持格式）
    const updated = JSON.stringify(config, null, 2);
    writeFileSync(configPath, updated + '\n', 'utf8');

    console.log(`[FIXED] ${dir}`);
    stats.fixed++;

  } catch (err) {
    console.error(`[ERROR] ${dir}: ${err.message}`);
    stats.errors.push({ dir, error: err.message });
  }
}

console.log('\n=== Summary ===');
console.log(`Total: ${stats.total}`);
console.log(`Fixed: ${stats.fixed}`);
console.log(`Skipped: ${stats.skipped}`);
console.log(`Errors: ${stats.errors.length}`);
if (stats.errors.length > 0) {
  console.log('\nFailed agents:');
  stats.errors.forEach(({ dir, error }) => console.log(`  ${dir}: ${error}`));
}
