/**
 * Gemini SessionFileAdapter
 *
 * Reads Gemini CLI session files from ~/.gemini/tmp/{project}/chats/.
 * Gemini stores sessions as JSON files with naming convention:
 *   session-{YYYY-MM-DDTHH-mm}-{uuid-prefix}.json
 *
 * Each file contains:
 *   { sessionId, projectHash, startTime, lastUpdated, messages, kind }
 *
 * Messages have type: 'user' | 'gemini' (not 'role').
 */

import type { CliSessionEntry, SdkSessionEntry, SessionFileAdapter, SessionFileInfo } from '../session-file-adapter.js';
import { logger } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

export class GeminiSessionFileAdapter implements SessionFileAdapter {
  readonly agentId = 'gemini';

  private getGeminiHome(): string {
    return path.join(os.homedir(), '.gemini');
  }

  /**
   * Resolve Gemini project key for a project path.
   * Priority:
   * 1. ~/.gemini/projects.json explicit mapping
   * 2. .project_root file content match under ~/.gemini/tmp/<project-key>/
   * 3. basename(projectPath) fallback
   */
  private resolveProjectKey(projectPath: string): string {
    const geminiHome = this.getGeminiHome();
    const projectsPath = path.join(geminiHome, 'projects.json');

    try {
      if (fs.existsSync(projectsPath)) {
        const data = JSON.parse(fs.readFileSync(projectsPath, 'utf-8'));
        const mapped = data?.projects?.[projectPath];
        if (typeof mapped === 'string' && mapped.trim()) return mapped;
      }
    } catch (error) {
      logger.debug('[GeminiAdapter] Failed to read projects.json:', error);
    }

    const tmpDir = path.join(geminiHome, 'tmp');
    if (fs.existsSync(tmpDir)) {
      try {
        for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const rootFile = path.join(tmpDir, entry.name, '.project_root');
          if (!fs.existsSync(rootFile)) continue;
          try {
            const content = fs.readFileSync(rootFile, 'utf-8').trim();
            if (content === projectPath) return entry.name;
          } catch {
            // ignore broken .project_root
          }
        }
      } catch (error) {
        logger.debug('[GeminiAdapter] Failed to scan tmp project roots:', error);
      }
    }

    return path.basename(projectPath);
  }

  /**
   * Resolve the Gemini chats directory for a given project path.
   */
  private resolveChatsDir(projectPath: string): string {
    const geminiHome = this.getGeminiHome();
    const projectKey = this.resolveProjectKey(projectPath);
    return path.join(geminiHome, 'tmp', projectKey, 'chats');
  }

  /**
   * Find the session file matching a given session UUID.
   * Gemini files are named session-{date}-{uuid-prefix}.json where
   * uuid-prefix is the first 8 chars of the session UUID.
   */
  findSessionFile(projectPath: string, agentSessionId: string): string | null {
    const chatsDir = this.resolveChatsDir(projectPath);
    if (!fs.existsSync(chatsDir)) return null;

    const uuidPrefix = agentSessionId.substring(0, 8);

    try {
      const files = fs.readdirSync(chatsDir);
      const match = files.find(f => f.includes(uuidPrefix) && f.endsWith('.json'));
      return match ? path.join(chatsDir, match) : null;
    } catch {
      return null;
    }
  }

  private readSessionData(projectPath: string, agentSessionId: string): any | null {
    const filePath = this.findSessionFile(projectPath, agentSessionId);
    if (!filePath) return null;

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      logger.warn(`[GeminiAdapter] Failed to read session file: ${filePath}`, error);
      return null;
    }
  }

  checkExists(projectPath: string, agentSessionId: string): boolean {
    return this.findSessionFile(projectPath, agentSessionId) !== null;
  }

  getFileInfo(projectPath: string, agentSessionId: string): SessionFileInfo {
    const data = this.readSessionData(projectPath, agentSessionId);
    if (!data) return { turns: 0 };

    const msgs = data.messages || [];
    const userTurns = msgs.filter((m: any) => m.type === 'user').length;

    // Extract title from first user message
    let title: string | undefined;
    const firstUser = msgs.find((m: any) => m.type === 'user');
    if (firstUser) {
      const text = Array.isArray(firstUser.content)
        ? firstUser.content[0]?.text || ''
        : String(firstUser.content || '');
      title = text.substring(0, 50).trim() || undefined;
    }

    return { turns: userTurns, title };
  }

  readFirstMessage(projectPath: string, agentSessionId: string): string | null {
    return this.readUserMessage(projectPath, agentSessionId, 'first');
  }

  readLastUserMessage(projectPath: string, agentSessionId: string): string | null {
    return this.readUserMessage(projectPath, agentSessionId, 'last');
  }

  scanCliSessions(projectPath: string): CliSessionEntry[] {
    const chatsDir = this.resolveChatsDir(projectPath);
    if (!fs.existsSync(chatsDir)) return [];

    try {
      const files = fs.readdirSync(chatsDir)
        .filter(f => f.startsWith('session-') && f.endsWith('.json'))
        .map(f => {
          const filePath = path.join(chatsDir, f);
          const stat = fs.statSync(filePath);
          // Extract UUID from filename: session-{date}-{uuid-prefix}.json
          // Read the file to get full UUID
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return { uuid: data.sessionId, mtime: stat.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((e): e is CliSessionEntry => e !== null)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 10);

      return files;
    } catch (error) {
      logger.warn('[GeminiAdapter] scanCliSessions failed:', error);
      return [];
    }
  }

  private readUserMessage(projectPath: string, agentSessionId: string, which: 'first' | 'last'): string | null {
    const data = this.readSessionData(projectPath, agentSessionId);
    if (!data) return null;

    const msgs = (data.messages || []).filter((m: any) => m.type === 'user');
    if (msgs.length === 0) return null;

    const msg = which === 'first' ? msgs[0] : msgs[msgs.length - 1];
    const text = Array.isArray(msg.content)
      ? msg.content[0]?.text || ''
      : String(msg.content || '');

    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : '');
  }
}
