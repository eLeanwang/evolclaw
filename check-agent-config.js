#!/usr/bin/env node
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const agentsDir = join(homedir(), '.evolclaw', 'agents');
const dirs = readdirSync(agentsDir)
  .filter(name => name.endsWith('.agentid.pub'))
  .sort();

const issues = {
  noOwners: [],
  noDefaultRoles: [],
  ok: []
};

for (const dir of dirs) {
  const configPath = join(agentsDir, dir, 'config.json');

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    const hasOwners = Array.isArray(config.owners) && config.owners.length > 0;
    const hasDefaultRoles = config.roles?.defaultRoles?.private && config.roles?.defaultRoles?.group;

    const status = {
      aid: config.aid || dir.replace('.agentid.pub', ''),
      owners: hasOwners ? config.owners : null,
      defaultRoles: hasDefaultRoles ? config.roles.defaultRoles : null,
    };

    if (!hasOwners) {
      issues.noOwners.push(status);
    }
    if (!hasDefaultRoles) {
      issues.noDefaultRoles.push(status);
    }
    if (hasOwners && hasDefaultRoles) {
      issues.ok.push(status);
    }

  } catch (err) {
    // Skip missing/invalid config
  }
}

console.log('=== Agents WITHOUT owners ===');
if (issues.noOwners.length === 0) {
  console.log('✓ All agents have owners configured');
} else {
  issues.noOwners.forEach(a => {
    console.log(`⚠️  ${a.aid}`);
  });
}

console.log('\n=== Agents WITHOUT defaultRoles ===');
if (issues.noDefaultRoles.length === 0) {
  console.log('✓ All agents have defaultRoles configured');
} else {
  issues.noDefaultRoles.forEach(a => {
    console.log(`⚠️  ${a.aid}`);
  });
}

console.log('\n=== Summary ===');
console.log(`Total valid configs: ${issues.ok.length + issues.noOwners.length + issues.noDefaultRoles.length}`);
console.log(`✓ Properly configured: ${issues.ok.length}`);
console.log(`⚠️  Missing owners: ${issues.noOwners.length}`);
console.log(`⚠️  Missing defaultRoles: ${issues.noDefaultRoles.length}`);

// Sample check
if (issues.ok.length > 0) {
  console.log('\n=== Sample (first 3 OK agents) ===');
  issues.ok.slice(0, 3).forEach(a => {
    console.log(`${a.aid}`);
    console.log(`  owners: ${a.owners.join(', ')}`);
    console.log(`  defaultRoles: private=${a.defaultRoles.private}, group=${a.defaultRoles.group}`);
  });
}
