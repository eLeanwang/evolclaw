#!/usr/bin/env node
import { SessionManager } from '../src/core/session-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const testDbPath = './data/test-group-isolation.db';
const testProjectPath = '/tmp/test-project';

// 清理测试环境
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

console.log('🧪 测试群聊会话物理隔离\n');

const manager = new SessionManager(testDbPath);

// 测试1: 私聊会话
console.log('📝 测试1: 私聊会话');
const privateSession = await manager.getOrCreateSession('feishu', 'ou_test123', testProjectPath);
console.log(`  会话ID: ${privateSession.id}`);
console.log(`  格式检查: ${privateSession.id.startsWith('agent-') ? '✅' : '❌'} (应该以 agent- 开头)`);

// 检查文件路径
const encodedPath = testProjectPath.replace(/\//g, '-');
const privateExpectedPath = path.join(os.homedir(), '.claude', 'projects', encodedPath, `${privateSession.id}.jsonl`);
console.log(`  预期路径: ${privateExpectedPath}`);
console.log(`  路径检查: ${!privateExpectedPath.includes('/group/') ? '✅' : '❌'} (不应该在 group/ 目录)\n`);

// 测试2: 群聊会话
console.log('📝 测试2: 群聊会话');
const groupSession = await manager.getOrCreateSession('feishu', 'oc_test456', testProjectPath);
console.log(`  会话ID: ${groupSession.id}`);
console.log(`  格式检查: ${groupSession.id.startsWith('feishu-oc_test456-') ? '✅' : '❌'} (应该以 feishu-oc_test456- 开头)`);

// 检查文件路径
const groupExpectedPath = path.join(os.homedir(), '.claude', 'projects', encodedPath, 'group', `${groupSession.id}.jsonl`);
console.log(`  预期路径: ${groupExpectedPath}`);
console.log(`  路径检查: ${groupExpectedPath.includes('/group/') ? '✅' : '❌'} (应该在 group/ 目录)\n`);

// 测试3: 验证隔离
console.log('📝 测试3: 验证物理隔离');
const privateDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);
const groupDir = path.join(privateDir, 'group');
console.log(`  私聊目录: ${privateDir}`);
console.log(`  群聊目录: ${groupDir}`);
console.log(`  目录隔离: ${privateDir !== groupDir ? '✅' : '❌'}\n`);

// 清理
manager.close();
fs.unlinkSync(testDbPath);

console.log('✅ 所有测试完成');
