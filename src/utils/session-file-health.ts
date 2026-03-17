import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

/**
 * 会话文件健康检查结果
 */
export interface SessionFileHealthResult {
  healthy: boolean;
  issues: string[];
  corrupt?: boolean;
  fileSize?: number;
}

/**
 * 检查会话文件是否存在
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查会话文件健康度
 */
export async function checkSessionFileHealth(
  projectPath: string,
  claudeSessionId: string
): Promise<SessionFileHealthResult> {
  const issues: string[] = [];
  const sessionFile = path.join(projectPath, '.claude', `${claudeSessionId}.jsonl`);

  // 检查文件是否存在
  if (!(await fileExists(sessionFile))) {
    // 新会话没有文件是正常的
    return { healthy: true, issues: [] };
  }

  try {
    // 检查文件大小
    const stats = await fs.stat(sessionFile);
    const sizeMB = stats.size / (1024 * 1024);

    if (stats.size > 50 * 1024 * 1024) {
      issues.push(`会话文件过大: ${sizeMB.toFixed(1)}MB`);
    }

    // 检查 JSON 格式
    const content = await fs.readFile(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (let i = 0; i < lines.length; i++) {
      try {
        JSON.parse(lines[i]);
      } catch (e) {
        issues.push(`会话文件格式损坏（第 ${i + 1} 行）`);
        return { healthy: false, issues, corrupt: true, fileSize: stats.size };
      }
    }

    return {
      healthy: issues.length === 0,
      issues,
      fileSize: stats.size
    };
  } catch (error: any) {
    logger.error('[SessionFileHealth] Check failed:', error);
    issues.push(`文件读取失败: ${error.message}`);
    return { healthy: false, issues, corrupt: true };
  }
}

/**
 * 备份会话目录
 */
export async function backupClaudeDir(projectPath: string): Promise<string> {
  const claudeDir = path.join(projectPath, '.claude');
  const backupDir = path.join(claudeDir, `backup-${Date.now()}`);

  await fs.cp(claudeDir, backupDir, { recursive: true });
  logger.info(`[SessionFileHealth] Backup created: ${backupDir}`);

  return backupDir;
}
