/**
 * Claude SessionFileAdapter
 *
 * Reads Claude Agent SDK session files from ~/.claude/projects/{encodedPath}/{sessionId}.jsonl
 * and wraps sdkListSessions for name synchronization.
 */

import type { SessionFileAdapter, SessionFileInfo, CliSessionEntry, SdkSessionEntry } from '../session-file-adapter.js';
import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import { encodePath } from '../../../utils/cross-platform.js';
import { logger } from '../../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

export class ClaudeSessionFileAdapter implements SessionFileAdapter {
  readonly agentId = 'claude';

  private getSessionFilePath(projectPath: string, agentSessionId: string): string {
    const homeDir = os.homedir();
    const encodedPath = encodePath(projectPath);
    return path.join(homeDir, '.claude', 'projects', encodedPath, `${agentSessionId}.jsonl`);
  }

  checkExists(projectPath: string, agentSessionId: string): boolean {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    return fs.existsSync(sessionFile);
  }

  getFileInfo(projectPath: string, agentSessionId: string): SessionFileInfo {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    if (!fs.existsSync(sessionFile)) return { turns: 0 };

    try {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let turns = 0;
      let title: string | undefined;
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'user' && event.message?.role === 'user') {
          const msgContent = event.message.content;
          const isToolResult = Array.isArray(msgContent) && msgContent.every((c: any) => c.type === 'tool_result');
          if (!isToolResult) {
            turns++;
          }
        }
        if (event.title && !title) {
          title = event.title;
        }
        if (event.sessionTitle && !title) {
          title = event.sessionTitle;
        }
      }
      return { turns, title };
    } catch (error) {
      logger.warn(`[ClaudeAdapter] Failed to read session file info: ${sessionFile}`, error);
      return { turns: 0 };
    }
  }

  readFirstMessage(projectPath: string, agentSessionId: string): string | null {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    if (!fs.existsSync(sessionFile)) return null;

    try {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'user' && event.message?.role === 'user') {
          const text = this.extractUserMessageText(event.message.content);
          if (text) return text;
        }
      }
    } catch (error) {
      logger.warn(`[ClaudeAdapter] Failed to read session file: ${sessionFile}`, error);
    }
    return null;
  }

  readLastUserMessage(projectPath: string, agentSessionId: string): string | null {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    if (!fs.existsSync(sessionFile)) return null;

    try {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let lastMessage: string | null = null;

      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'user' && event.message?.role === 'user') {
          lastMessage = this.extractUserMessageText(event.message.content) ?? lastMessage;
        }
      }
      return lastMessage;
    } catch (error) {
      logger.warn(`[ClaudeAdapter] Failed to read last message from session file: ${sessionFile}`, error);
    }
    return null;
  }

  // CLI 会话白名单：只有真正由人手发起的终端会话才值得导入。
  // 其它 entrypoint（sdk-ts=EvolClaw 自身、sdk-py=security-guidance 等插件的后台 SDK 会话）
  // 同样把 JSONL 写进项目目录，但不是用户会话，导入它们没有意义。
  private static readonly CLI_ENTRYPOINTS = new Set(['cli', 'sdk-cli']);
  // entrypoint 不可变，进程内缓存 filePath→entrypoint，避免重复读文件头部
  private readonly entrypointCache = new Map<string, string | null>();

  // entrypoint 字段位于首个 user 事件行（实测恒在前 4 行内，cli 会话首次出现 < 8KB）。
  // 插件会话首行 queue-operation 可能携带巨大 diff（数百 KB），把 entrypoint 推到很后面，
  // 因此读取上限设为 32KB：cli 会话必命中，插件会话要么命中 sdk-py、要么读不到 → 一律排除。
  private static readonly ENTRYPOINT_SCAN_BYTES = 32 * 1024;

  /** 读取会话文件的 entrypoint，结果缓存在实例内（entrypoint 不可变，无需失效）。 */
  private readEntrypoint(filePath: string): string | null {
    if (this.entrypointCache.has(filePath)) return this.entrypointCache.get(filePath)!;
    let fd: number | undefined;
    let result: string | null = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.allocUnsafe(ClaudeSessionFileAdapter.ENTRYPOINT_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString('utf-8', 0, bytesRead);
      const m = head.match(/"entrypoint":"([^"]*)"/);
      result = m ? m[1] : null;
    } catch {
      // keep null
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    this.entrypointCache.set(filePath, result);
    return result;
  }

  scanCliSessions(projectPath: string): CliSessionEntry[] {
    const homeDir = os.homedir();
    const encodedPath = encodePath(projectPath);
    const sessionDir = path.join(homeDir, '.claude', 'projects', encodedPath);

    if (!fs.existsSync(sessionDir)) return [];

    const candidates = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('agent-'))
      .map(f => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return { uuid: f.replace('.jsonl', ''), filePath, mtime: stat.mtimeMs, size: stat.size };
      })
      .filter(f => f.size > 0)
      .sort((a, b) => b.mtime - a.mtime);

    // 按 mtime 降序惰性判定 entrypoint，凑够 10 个白名单会话即停，避免读取全部文件。
    const result: CliSessionEntry[] = [];
    for (const f of candidates) {
      const entrypoint = this.readEntrypoint(f.filePath);
      if (entrypoint && ClaudeSessionFileAdapter.CLI_ENTRYPOINTS.has(entrypoint)) {
        result.push({ uuid: f.uuid, mtime: f.mtime });
        if (result.length >= 10) break;
      }
    }
    return result;
  }

  async listSdkSessions(projectPath: string): Promise<SdkSessionEntry[]> {
    try {
      const sessions = await sdkListSessions({ dir: projectPath });
      return sessions.map(s => ({
        sessionId: s.sessionId,
        title: s.customTitle || undefined,
      }));
    } catch (error) {
      logger.debug('[ClaudeAdapter] SDK listSessions failed (non-critical):', error);
      return [];
    }
  }

  private extractUserMessageText(messageContent: any): string | null {
    if (typeof messageContent === 'string') {
      const text = messageContent.trim().replace(/\s+/g, ' ');
      return text.substring(0, 50) + (text.length > 50 ? '...' : '');
    } else if (Array.isArray(messageContent)) {
      const textContent = messageContent.find((c: any) => c.type === 'text');
      if (textContent?.text) {
        const text = textContent.text.trim().replace(/\s+/g, ' ');
        return text.substring(0, 50) + (text.length > 50 ? '...' : '');
      }
    }
    return null;
  }
}
