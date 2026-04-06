import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolvePaths } from '../paths.js';
import { loadConfig, saveConfig } from '../config.js';

/** 将绝对路径编码为 Claude Code 的目录名格式（/ \ . 替换为 -） */
function encodePath(p: string): string {
  return p.replace(/[/\\\.]/g, '-');
}

/** 查找最新的 ~/.codex/state_*.sqlite */
function findCodexDb(): string | null {
  const codexHome = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexHome)) return null;
  const files = fs.readdirSync(codexHome)
    .filter(f => /^state_\d+\.sqlite$/.test(f))
    .sort((a, b) => {
      const va = parseInt(a.match(/state_(\d+)/)?.[1] || '0');
      const vb = parseInt(b.match(/state_(\d+)/)?.[1] || '0');
      return vb - va;
    });
  return files.length > 0 ? path.join(codexHome, files[0]) : null;
}

export interface MigrateResult {
  claudeSessionsMoved: boolean;
  claudeHistoryUpdated: boolean;
  codexUpdated: number;
  evolclawDbUpdated: number;
  evolclawConfigUpdated: boolean;
  directoryMoved: boolean;
}

export async function migrateProject(oldPath: string, newPath: string): Promise<MigrateResult> {
  const result: MigrateResult = {
    claudeSessionsMoved: false,
    claudeHistoryUpdated: false,
    codexUpdated: 0,
    evolclawDbUpdated: 0,
    evolclawConfigUpdated: false,
    directoryMoved: false,
  };

  const oldAbs = path.resolve(oldPath);
  const newAbs = path.resolve(newPath);

  if (!fs.existsSync(oldAbs)) throw new Error(`源目录不存在: ${oldAbs}`);
  if (fs.existsSync(newAbs)) throw new Error(`目标目录已存在: ${newAbs}`);

  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  const oldEncoded = encodePath(oldAbs);
  const newEncoded = encodePath(newAbs);

  // 1. 迁移 ~/.claude/projects/{encoded}/
  const oldClaudeDir = path.join(claudeProjects, oldEncoded);
  const newClaudeDir = path.join(claudeProjects, newEncoded);
  if (fs.existsSync(oldClaudeDir)) {
    fs.renameSync(oldClaudeDir, newClaudeDir);
    result.claudeSessionsMoved = true;
  }

  // 2. .jsonl 内部路径不需要替换 — 它们是历史对话记录，
  //    resume 时模型会根据当前 cwd 工作，旧路径只是历史上下文

  // 3. 更新 ~/.claude/history.jsonl
  const historyFile = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (fs.existsSync(historyFile)) {
    const lines = fs.readFileSync(historyFile, 'utf-8').split('\n');
    const updated = lines.map(line => {
      if (!line.trim()) return line;
      try {
        const obj = JSON.parse(line);
        if (obj.project === oldAbs) { obj.project = newAbs; return JSON.stringify(obj); }
      } catch { /* skip */ }
      return line;
    });
    const newContent = updated.join('\n');
    if (newContent !== fs.readFileSync(historyFile, 'utf-8')) {
      fs.writeFileSync(historyFile, newContent, 'utf-8');
      result.claudeHistoryUpdated = true;
    }
  }

  // 4. 更新 Codex SQLite threads.cwd
  const codexDbPath = findCodexDb();
  if (codexDbPath) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(codexDbPath);
      const r = db.prepare('UPDATE threads SET cwd = ? WHERE cwd = ?').run(newAbs, oldAbs) as any;
      result.codexUpdated = r.changes ?? 0;
      db.close();
    } catch { /* Codex not installed or DB locked */ }
  }

  // 5. 移动项目目录
  fs.renameSync(oldAbs, newAbs);
  result.directoryMoved = true;

  // 6. 更新 EvolClaw sessions.db
  const p = resolvePaths();
  if (fs.existsSync(p.db)) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(p.db);
      const r = db.prepare('UPDATE sessions SET project_path = ? WHERE project_path = ?').run(newAbs, oldAbs) as any;
      result.evolclawDbUpdated = r.changes ?? 0;
      db.close();
    } catch { /* DB not accessible */ }
  }

  // 7. 更新 evolclaw.json projects.list
  if (fs.existsSync(p.config)) {
    try {
      const config = loadConfig(p.config);
      if (config.projects?.list) {
        let changed = false;
        for (const [k, v] of Object.entries(config.projects.list)) {
          if (v === oldAbs) { config.projects.list[k] = newAbs; changed = true; }
        }
        if (changed) { saveConfig(config, p.config); result.evolclawConfigUpdated = true; }
      }
    } catch { /* config not accessible */ }
  }

  return result;
}
