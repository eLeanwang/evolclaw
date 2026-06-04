import fs from 'fs';
import path from 'path';

export type CreatePhase =
  | 'validating' | 'registering_aid' | 'config_saved'
  | 'uploading_agentmd' | 'applying_config' | 'hot_loading';

export type StepState = 'in_progress' | 'done' | 'warn' | 'failed';

export interface CreateStep { phase: CreatePhase; state: StepState; detail?: string; ts: number; }

export interface CreateStatus {
  aid: string;
  status: 'in_progress' | 'ready' | 'failed';
  currentPhase: CreatePhase | null;
  steps: CreateStep[];
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

const FILE = 'create-status.json';

export function readCreateStatus(agentDir: string): CreateStatus | null {
  try {
    const raw = fs.readFileSync(path.join(agentDir, FILE), 'utf-8');
    return JSON.parse(raw) as CreateStatus;
  } catch { return null; }
}

/** 删除构建进度文件（agent 删除时清理）。非 purge 删除只移除 config.json，
 *  故需显式清理本文件，避免目录残留陈旧进度。 */
export function removeCreateStatus(agentDir: string): void {
  try { fs.rmSync(path.join(agentDir, FILE), { force: true }); } catch { /* ignore */ }
}

/** 构建进度写入器。每次状态变更原子落盘（写临时文件 + rename）。 */
export class CreateStatusWriter {
  private status: CreateStatus;
  constructor(private agentDir: string, aid: string) {
    const now = Date.now();
    this.status = { aid, status: 'in_progress', currentPhase: null, steps: [], error: null, startedAt: now, updatedAt: now };
    fs.mkdirSync(agentDir, { recursive: true });
    this.flush();
  }
  begin(phase: CreatePhase): void {
    this.status.currentPhase = phase;
    this.status.steps.push({ phase, state: 'in_progress', ts: Date.now() });
    this.flush();
  }
  done(phase: CreatePhase, detail?: string): void { this.mark(phase, 'done', detail); }
  warn(phase: CreatePhase, detail?: string): void { this.mark(phase, 'warn', detail); }
  finishReady(): void { this.status.status = 'ready'; this.status.currentPhase = null; this.flush(); }
  finishFailed(phase: CreatePhase, error: string): void {
    this.mark(phase, 'failed', error);
    this.status.status = 'failed';
    this.status.error = error;
    this.status.currentPhase = null;
    this.flush();
  }
  private mark(phase: CreatePhase, state: StepState, detail?: string): void {
    const step = [...this.status.steps].reverse().find(s => s.phase === phase);
    if (step) { step.state = state; if (detail) step.detail = detail; step.ts = Date.now(); }
    else { this.status.steps.push({ phase, state, detail, ts: Date.now() }); }
    this.flush();
  }
  private flush(): void {
    this.status.updatedAt = Date.now();
    const file = path.join(this.agentDir, FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.status, null, 2));
    fs.renameSync(tmp, file);
  }
}
