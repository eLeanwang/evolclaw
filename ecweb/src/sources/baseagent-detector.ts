/**
 * Base agent 环境检测 — 检测 Claude 和 Codex 的可用性。
 *
 * 检测条件：
 * - Claude: ~/.claude/projects/ 目录存在
 * - Codex: ~/.codex/sessions/ 和 ~/.codex/state_*.sqlite 存在，且 Node 版本 >= 22.5
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const requireFromHere = createRequire(import.meta.url);

export type BaseAgentType = 'claude' | 'codex';

export interface BaseAgentAvailability {
  claude: boolean;
  codex: boolean;
}

let _cached: BaseAgentAvailability | null = null;

/**
 * 检测 node:sqlite 模块是否可用（Node 22.5+）
 */
function checkSqliteAvailable(): boolean {
  try {
    requireFromHere('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * 检测 Codex state_*.sqlite 文件是否存在
 */
function checkCodexStateDb(): boolean {
  const codexHome = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexHome)) return false;

  try {
    const files = fs.readdirSync(codexHome).filter(f => /^state_\d+\.sqlite$/.test(f));
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * 检测 Claude projects 目录是否存在
 */
function checkClaudeProjects(): boolean {
  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  return fs.existsSync(claudeProjects);
}

/**
 * 检测 Codex sessions 目录是否存在
 */
function checkCodexSessions(): boolean {
  const codexSessions = path.join(os.homedir(), '.codex', 'sessions');
  return fs.existsSync(codexSessions);
}

/**
 * 检测所有 base agent 的可用性
 * 结果会缓存，避免重复检测
 */
export function detectBaseAgents(): BaseAgentAvailability {
  if (_cached) return _cached;

  const claude = checkClaudeProjects();
  const codex = checkCodexSessions() && checkCodexStateDb() && checkSqliteAvailable();

  _cached = { claude, codex };
  return _cached;
}

/**
 * 重置缓存（测试用）
 */
export function resetDetectionCache(): void {
  _cached = null;
}
