/**
 * Claude SessionFileAdapter
 *
 * Reads Claude Agent SDK session files from ~/.claude/projects/{encodedPath}/{sessionId}.jsonl
 * and wraps sdkListSessions for name synchronization.
 */

import type { SessionFileAdapter, SessionFileInfo, CliSessionEntry, SdkSessionEntry } from '../session-file-adapter.js';
import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import { encodePath } from '../../utils/cross-platform.js';
import { logger } from '../../utils/logger.js';
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

  scanCliSessions(projectPath: string): CliSessionEntry[] {
    const homeDir = os.homedir();
    const encodedPath = encodePath(projectPath);
    const sessionDir = path.join(homeDir, '.claude', 'projects', encodedPath);

    if (!fs.existsSync(sessionDir)) return [];

    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('agent-'))
      .map(f => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return { uuid: f.replace('.jsonl', ''), mtime: stat.mtimeMs, size: stat.size };
      })
      .filter(f => f.size > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    return files.map(f => ({ uuid: f.uuid, mtime: f.mtime }));
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
