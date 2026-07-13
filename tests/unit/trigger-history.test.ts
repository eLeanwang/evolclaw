import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { TriggerAuditLogger } from '../../src/trigger/audit.js';
import { TriggerDefinitionManager } from '../../src/trigger/manager.js';
import { TriggerRuntimeScheduler } from '../../src/trigger/scheduler.js';
import type { TriggerAuditRecord } from '../../src/trigger/types.js';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('TriggerHistoryStore', () => {
  it('keeps full definition snapshots across update, disable, and delete', () => {
    const { manager } = setup();
    const created = manager.create(definition('history-one', 'first'), [], { enable: true });
    const updated = manager.update(created.id, definition('history-one', 'second'));
    manager.setEnabled(created.id, false);
    manager.delete(created.id);

    expect(manager.get(created.id)).toBeUndefined();
    const events = manager.history.events(created.id, 10).reverse();
    expect(events.map(event => event.type)).toEqual([
      'trigger.created',
      'trigger.updated',
      'trigger.disabled',
      'trigger.deleted',
    ]);
    expect(events[0]).toMatchObject({
      definition: { execution: { prompt: 'first' } },
    });
    expect(events[1]).toMatchObject({
      definition: { execution: { prompt: 'second' } },
    });
    expect(events[3]).toMatchObject({
      definition: { enabled: false },
    });
    expect(updated.execution.prompt).toBe('second');
    expect(fs.existsSync(path.join(manager.rootDir, 'history.jsonl'))).toBe(true);
  });

  it('uses history for lifetime run stats and recent runs', () => {
    const { manager, audit } = setup();
    const created = manager.create(definition('history-runs', 'run'));
    audit.write(runRecord(created.id, 'run-1', 'completed', 100));
    audit.write(runRecord(created.id, 'run-2', 'failed', 200));
    audit.write(runRecord(created.id, 'run-3', 'skipped', 300, 250));

    expect(audit.stats(created.id)).toEqual({
      fireCount: 2,
      failCount: 1,
      lastFiredAt: 200,
      lastResult: 'failed',
    });
    expect(audit.recent(created.id, 2).map(record => record.runId)).toEqual(['run-3', 'run-2']);
    expect(audit.hasSkippedSchedule(created.id, 250)).toBe(true);

    fs.rmSync(path.join(tmpDir!, 'logs'), { recursive: true, force: true });
    expect(audit.stats(created.id).fireCount).toBe(2);
    expect(audit.recent(created.id, 5)).toHaveLength(3);
  });

  it('imports retained audit logs once', () => {
    const { manager, logsDir } = setup(false);
    fs.mkdirSync(logsDir, { recursive: true });
    const auditRecord = runRecord('legacy-trigger', 'legacy-run', 'completed', 123);
    fs.writeFileSync(path.join(logsDir, 'trigger-runs.log'), `${JSON.stringify(auditRecord)}\n`);

    const first = new TriggerAuditLogger(logsDir, manager.history);
    expect(first.recent('legacy-trigger', 10)).toHaveLength(1);
    const second = new TriggerAuditLogger(logsDir, manager.history);
    expect(second.recent('legacy-trigger', 10)).toHaveLength(1);
  });

  it('keeps legacy archived history visible without rewriting old lines', () => {
    const { manager } = setup();
    const legacy = {
      id: 'legacy-archived',
      name: 'legacy archived',
      schedulerAid: 'test.agentid.pub',
      fireCount: 12,
      failCount: 1,
      lastFiredAt: 456,
      lastResult: 'completed',
      doneAt: 500,
      doneReason: 'cancelled',
    };
    fs.writeFileSync(manager.history.file, `${JSON.stringify(legacy)}\n`);

    expect(manager.history.events('legacy-archived', 10)).toEqual([
      expect.objectContaining({
        type: 'trigger.legacy_archived',
        timestamp: 500,
        legacyRecord: legacy,
      }),
    ]);
    expect(manager.history.stats('legacy-archived')).toEqual({
      fireCount: 12,
      failCount: 1,
      lastFiredAt: 456,
      lastResult: 'completed',
    });
    expect(fs.readFileSync(manager.history.file, 'utf8')).toBe(`${JSON.stringify(legacy)}\n`);
  });

  it('exposes history through the scheduler query boundary', () => {
    const { manager, audit } = setup();
    const created = manager.create(definition('history-query', 'query'));
    audit.write(runRecord(created.id, 'query-run', 'completed', 600));
    const scheduler = new TriggerRuntimeScheduler(
      manager,
      {} as any,
      audit,
      {} as any,
      {} as any,
      {} as any,
      { projectPath: tmpDir!, baseagent: 'codex' },
    );

    expect(scheduler.history(created.id, 10).map(event => event.type)).toEqual([
      'run.completed',
      'trigger.created',
    ]);
  });

  it('uses the history legacy baseline instead of adding migrated snapshot stats again', () => {
    const { manager, audit } = setup();
    const triggerId = 'legacy-overlap';
    const legacy = {
      id: triggerId,
      schedulerAid: 'test.agentid.pub',
      fireCount: 12,
      failCount: 1,
      lastFiredAt: 500,
      lastResult: 'completed',
      doneAt: 510,
    };
    fs.writeFileSync(manager.history.file, `${JSON.stringify(legacy)}\n`);
    fs.writeFileSync(path.join(manager.rootDir, 'triggers.legacy.migrated.1.json'), JSON.stringify({
      [triggerId]: legacy,
    }));
    audit.write(runRecord(triggerId, 'new-run', 'completed', 600));
    const scheduler = new TriggerRuntimeScheduler(
      manager,
      { readSchedule: () => undefined } as any,
      audit,
      {} as any,
      {} as any,
      {} as any,
      { projectPath: tmpDir!, baseagent: 'codex' },
    );

    expect(scheduler.stats(triggerId)).toEqual({
      fireCount: 13,
      failCount: 1,
      lastFiredAt: 600,
      lastResult: 'completed',
    });
  });
});

function setup(withAudit = true): {
  manager: TriggerDefinitionManager;
  audit: TriggerAuditLogger;
  logsDir: string;
} {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-history-'));
  const manager = new TriggerDefinitionManager('test.agentid.pub', path.join(tmpDir, 'triggers'));
  const logsDir = path.join(tmpDir, 'logs');
  const audit = withAudit
    ? new TriggerAuditLogger(logsDir, manager.history)
    : undefined as unknown as TriggerAuditLogger;
  return { manager, audit, logsDir };
}

function definition(id: string, prompt: string): Record<string, unknown> {
  return {
    $schema_version: 4,
    id,
    agentAid: 'test.agentid.pub',
    enabled: true,
    name: id,
    source: { type: 'event', eventPattern: 'test:event' },
    execution: {
      type: 'target_session',
      prompt,
      onError: 'fail',
      noopSentinel: '[[NOOP]]',
    },
    feedback: {
      strategy: 'target',
      target: {
        channelKey: 'test-channel',
        channelId: 'test-channel-id',
        session: 'main',
      },
    },
    reliability: {
      concurrency: 'forbid',
      missedPolicy: 'run_once',
      retry: { maxAttempts: 0, backoffMs: 1 },
    },
  };
}

function runRecord(
  triggerId: string,
  runId: string,
  status: TriggerAuditRecord['status'],
  finishedAt: number,
  scheduledAt?: number,
): TriggerAuditRecord {
  return {
    runId,
    triggerId,
    agentAid: 'test.agentid.pub',
    startedAt: finishedAt - 10,
    finishedAt,
    status,
    definition: {
      schemaVersion: 4,
      revision: 'revision',
      name: triggerId,
    },
    source: {
      type: 'event',
      firedAt: finishedAt - 10,
      scheduledAt,
      payload: {},
    },
    processing: null,
    script: null,
    reply: null,
    feedback: null,
    effects: [],
    error: status === 'failed' ? { code: 'failed', message: 'failed' } : null,
  };
}
