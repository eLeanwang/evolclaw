import { spawn } from 'child_process';
import type { TriggerDefinition, TriggerScriptResult } from './types.js';
import {
  previewText,
  resolveScriptPath,
  sha256,
} from './validation.js';

export interface ScriptExecutionInput {
  trigger: TriggerDefinition;
  triggerDir: string;
  runId: string;
  firedAt: number;
  sourcePayload: Record<string, unknown>;
  signal?: AbortSignal;
}

export class TriggerScriptExecutor {
  async execute(input: ScriptExecutionInput): Promise<TriggerScriptResult> {
    const script = input.trigger.processing.mode === 'script'
      ? input.trigger.processing.script
      : undefined;
    if (!script) {
      return {
        exitCode: 0,
        durationMs: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        result: {
          matched: true,
          text: '',
          data: { source: input.sourcePayload },
        },
      };
    }

    const scriptAbs = resolveScriptPath(input.triggerDir, script.path);
    const timeoutMs = script.timeoutMs ?? 30_000;
    const payload = {
      trigger: {
        id: input.trigger.id,
        name: input.trigger.name,
        agentAid: input.trigger.agentAid,
      },
      run: {
        id: input.runId,
        firedAt: input.firedAt,
      },
      source: {
        type: input.trigger.source.type,
        payload: input.sourcePayload,
      },
      args: script.args ?? {},
    };

    return await this.spawnProcess(script.runtime, [scriptAbs], JSON.stringify(payload), timeoutMs, input.signal);
  }

  private spawnProcess(command: string, args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<TriggerScriptResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let aborted = false;
      const cmd = command === 'node' ? process.execPath : command;

      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: process.env,
      });

      const abortHandler = () => {
        aborted = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 2_000).unref();
      };
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener('abort', abortHandler, { once: true });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 2_000).unref();
      }, timeoutMs);
      timer.unref();

      child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, Buffer.from(chunk)]); });
      child.stderr.on('data', (chunk) => { stderr = Buffer.concat([stderr, Buffer.from(chunk)]); });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        resolve(this.errorResult(startedAt, stdout, stderr, 'SCRIPT_SPAWN_ERROR', err.message, 127));
      });
      child.on('close', (code, closeSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        if (aborted) {
          resolve(this.errorResult(startedAt, stdout, stderr, 'SCRIPT_ABORTED', 'script was aborted', code ?? 130));
          return;
        }
        if (timedOut) {
          resolve(this.errorResult(startedAt, stdout, stderr, 'SCRIPT_TIMEOUT', `script timed out after ${timeoutMs}ms`, code ?? 124));
          return;
        }
        if ((code ?? 0) !== 0) {
          resolve(this.errorResult(startedAt, stdout, stderr, 'SCRIPT_EXIT_NON_ZERO', `script exited with code ${code ?? `signal ${closeSignal}`}`, code ?? 1));
          return;
        }
        const text = stdout.toString('utf-8').trim();
        let result: Record<string, unknown>;
        try {
          result = text ? JSON.parse(text) : {};
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('stdout JSON must be an object');
          }
        } catch (err: any) {
          resolve(this.errorResult(startedAt, stdout, stderr, 'SCRIPT_RESULT_PARSE_ERROR', err?.message || String(err), 1));
          return;
        }
        resolve({
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          stdoutHash: sha256(stdout),
          stderrHash: stderr.length ? sha256(stderr) : undefined,
          stdoutPreview: previewText(stdout.toString('utf-8')),
          stderrPreview: stderr.length ? previewText(stderr.toString('utf-8')) : undefined,
          result,
        });
      });

      child.stdin.end(stdin);
    });
  }

  private errorResult(
    startedAt: number,
    stdout: Buffer,
    stderr: Buffer,
    code: string,
    message: string,
    exitCode: number,
  ): TriggerScriptResult {
    const stdoutText = stdout.toString('utf-8');
    const stderrText = stderr.toString('utf-8');
    return {
      exitCode,
      durationMs: Date.now() - startedAt,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      stdoutHash: stdout.length ? sha256(stdout) : undefined,
      stderrHash: stderr.length ? sha256(stderr) : undefined,
      stdoutPreview: stdout.length ? previewText(stdoutText) : undefined,
      stderrPreview: stderr.length ? previewText(stderrText) : undefined,
      error: {
        code,
        message,
        stdoutPreview: stdout.length ? previewText(stdoutText) : undefined,
        stderrPreview: stderr.length ? previewText(stderrText) : undefined,
      },
    };
  }
}
