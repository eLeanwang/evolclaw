#!/usr/bin/env npx tsx
/**
 * 一次性迁移脚本：将 evolclaw.json 从旧结构迁移到新结构
 *
 * 用法: npx tsx scripts/migrate-config.ts [config-path]
 * 默认读取 EVOLCLAW_HOME/data/evolclaw.json 或 ~/.evolclaw/data/evolclaw.json
 *
 * 旧结构 → 新结构变化：
 * - feishu, wechat, aun → channels.feishu, channels.wechat, channels.aun
 * - anthropic + sdk → agents.anthropic（sdk 字段摊平）
 * - timeout.idle + idleMonitor → idleMonitor.timeout
 * - owners → 分散到各 channel.owner
 * - feishu, aun 新增 enabled: true
 * - 删除废弃字段 claude
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

function resolveConfigPath(arg?: string): string {
  if (arg) return path.resolve(arg);
  const home = process.env.EVOLCLAW_HOME || path.join(os.homedir(), '.evolclaw');
  return path.join(home, 'data', 'evolclaw.json');
}

function migrate(configPath: string): void {
  if (!fs.existsSync(configPath)) {
    console.error(`❌ 配置文件不存在: ${configPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // 检测是否已经是新结构
  if (raw.channels || raw.agents) {
    console.log('✓ 配置已是新结构，无需迁移');
    return;
  }

  // 检测是否是旧结构
  if (!raw.feishu && !raw.aun && !raw.anthropic) {
    console.log('⚠ 无法识别的配置结构，跳过迁移');
    return;
  }

  console.log('🔄 开始迁移配置...\n');

  const newConfig: any = {};

  // 1. agents: anthropic + sdk 合并
  newConfig.agents = {};
  if (raw.anthropic || raw.sdk) {
    newConfig.agents.anthropic = {
      ...(raw.anthropic || {}),
      ...(raw.sdk || {}),
    };
  }

  // 2. channels: feishu, wechat, aun
  newConfig.channels = {};

  if (raw.feishu) {
    newConfig.channels.feishu = {
      enabled: true,
      ...raw.feishu,
      owner: raw.owners?.feishu || '',
    };
  }

  if (raw.wechat) {
    newConfig.channels.wechat = {
      ...raw.wechat,
      owner: raw.owners?.wechat || '',
    };
  }

  if (raw.aun) {
    newConfig.channels.aun = {
      enabled: true,
      ...raw.aun,
      owner: raw.owners?.aun || '',
    };
  }

  // 3. projects: 不变
  if (raw.projects) {
    newConfig.projects = raw.projects;
  }

  // 4. idleMonitor: 合并 timeout.idle
  const idleMonitor: any = { ...(raw.idleMonitor || {}) };
  if (raw.timeout?.idle != null) {
    idleMonitor.timeout = raw.timeout.idle;
  }
  if (Object.keys(idleMonitor).length > 0) {
    newConfig.idleMonitor = idleMonitor;
  }

  // 5. flushDelay: 不变
  if (raw.flushDelay != null) {
    newConfig.flushDelay = raw.flushDelay;
  }

  // 备份旧文件
  const backupPath = configPath + '.bak';
  fs.copyFileSync(configPath, backupPath);
  console.log(`  ✓ 旧配置已备份: ${backupPath}`);

  // 写入新配置
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + '\n');
  console.log(`  ✓ 新配置已写入: ${configPath}`);

  // 显示变化摘要
  console.log('\n📋 迁移摘要:');
  if (raw.anthropic || raw.sdk) console.log('  - anthropic + sdk → agents.anthropic');
  if (raw.feishu) console.log('  - feishu → channels.feishu (enabled: true)');
  if (raw.wechat) console.log('  - wechat → channels.wechat');
  if (raw.aun) console.log('  - aun → channels.aun (enabled: true)');
  if (raw.owners) console.log('  - owners → 分散到各 channel.owner');
  if (raw.timeout?.idle) console.log('  - timeout.idle → idleMonitor.timeout');
  if (raw.claude) console.log('  - claude → 已删除（废弃字段）');
  console.log('\n✅ 迁移完成');
}

const configPath = resolveConfigPath(process.argv[2]);
migrate(configPath);
