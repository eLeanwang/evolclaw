import fsPromises from 'fs/promises';
import path from 'path';
import { logger } from '../../utils/logger.js';

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
 * 检查会话文件健康度（接收完整文件路径）
 */
export async function checkSessionFile(sessionFile: string): Promise<SessionFileHealthResult> {
  const issues: string[] = [];

  try {
    const stats = await fsPromises.stat(sessionFile);
    const sizeMB = stats.size / (1024 * 1024);

    if (stats.size > 50 * 1024 * 1024) {
      issues.push(`会话文件过大: ${sizeMB.toFixed(1)}MB`);
    }

    const content = await fsPromises.readFile(sessionFile, 'utf-8');
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
 * 备份单个会话文件（在同目录下创建 .bak 副本）
 */
export async function backupSessionFile(sessionFile: string): Promise<string> {
  const backupPath = `${sessionFile}.bak-${Date.now()}`;
  await fsPromises.copyFile(sessionFile, backupPath);
  logger.info(`[SessionFileHealth] Backup created: ${backupPath}`);
  return backupPath;
}
