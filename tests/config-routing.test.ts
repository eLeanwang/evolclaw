import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import {
  ConfigTarget,
  ensureFile,
  read,
  resolveEffective,
  routeFieldPath,
  validateConfig,
  write,
} from '../src/config/config-manager.js';
import { collectConfigFiles } from '../src/config/snapshot.js';
import { setRoleAssignment } from '../src/config/role-assignments.js';
import { resolvePermissionMode } from '../src/core/model/config-scope.js';
import { DEFAULT_PERMISSION_MODE } from '../src/types.js';
import { DEFAULT_FLUSH_DELAY_MS, DEFAULT_FLUSH_DELAY_SECONDS } from '../src/core/defaults.js';

describe('config ownership routing', () => {
  it('routes behavior paths to behavior targets and infra paths to H config', () => {
    expect(routeFieldPath('chatmode.private', 'agent').target).toBe(ConfigTarget.Behavior);
    expect(routeFieldPath('dispatch', 'agent').target).toBe(ConfigTarget.Behavior);
    expect(routeFieldPath('permissionMode', 'relation').target).toBe(ConfigTarget.RelationBehavior);
    expect(routeFieldPath('baseagents.claude.model', 'agent').target).toBe(ConfigTarget.Behavior);
    expect(routeFieldPath('baseagents.codex.reasoning', 'relation').target).toBe(ConfigTarget.RelationBehavior);
    expect(routeFieldPath('baseagents.claude.apiKey', 'agent').target).toBe(ConfigTarget.Agent);
    expect(routeFieldPath('projects.defaultPath', 'agent').target).toBe(ConfigTarget.Agent);
  });

  it('writes behavior config into behavior.json and overlays H config in effective view', () => {
    const sel = { self: 'bot.agentid.pub' };
    ensureFile(ConfigTarget.Agent, sel);
    write(ConfigTarget.Agent, {
      aid: 'bot.agentid.pub',
      channels: [],
      dispatch: 'mention',
      baseagents: { claude: { apiKey: '${ANTHROPIC_API_KEY}' } },
    }, sel);
    write(ConfigTarget.Behavior, {
      dispatch: 'broadcast',
      chatmode: { private: 'proactive' },
      baseagents: { claude: { model: 'claude-sonnet-4' } },
    }, sel);

    const effective = resolveEffective(sel);
    expect(effective.dispatch).toBe('broadcast');
    expect(effective.chatmode?.private).toBe('proactive');
    expect(effective.baseagents?.claude?.model).toBe('claude-sonnet-4');

    const p = resolvePaths();
    expect(fs.existsSync(path.join(p.agentsDir, 'bot.agentid.pub', 'behavior.json'))).toBe(true);
  });

  it('normalizes legacy H dispatch values in the effective view but rejects them in canonical behavior', () => {
    const sel = { self: 'legacy.agentid.pub' };
    write(ConfigTarget.Agent, {
      aid: 'legacy.agentid.pub',
      channels: [],
      dispatch: 'all',
    }, sel, { skipValidate: true });

    expect(resolveEffective(sel).dispatch).toBe('broadcast');
    expect(validateConfig(ConfigTarget.Behavior, { dispatch: 'all' })).not.toEqual([]);
    expect(validateConfig(ConfigTarget.Behavior, { dispatch: 'broadcast' })).toEqual([]);
  });

  it('validates permissionMode and idleMonitor schema ownership', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('auto');
    expect(resolvePermissionMode({ role: 'owner' })).toBe('bypass');
    expect(resolvePermissionMode({ role: 'admin' })).toBe('request');
    expect(resolvePermissionMode({ role: 'guest' })).toBe('readonly');
    expect(resolvePermissionMode({ role: 'anonymous' })).toBe('readonly');
    expect(resolvePermissionMode({ role: 'member' })).toBe('auto');

    expect(validateConfig(ConfigTarget.Behavior, { permissionMode: 'invalid' })).not.toEqual([]);
    expect(validateConfig(ConfigTarget.Behavior, { permissionMode: 'auto' })).toEqual([]);
    expect(validateConfig(ConfigTarget.Process, { idleMonitor: { enabled: false, timeout: 10 } })).toEqual([]);
  });

  it('rejects old role assignment fields from agent and relation config', () => {
    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'member-schema.agentid.pub',
      channels: [],
      members: ['peer.agentid.pub'],
    })).not.toEqual([]);

    expect(validateConfig(ConfigTarget.Relation, {
      role: 'guest',
    })).not.toEqual([]);
  });

  it('writes role assignments to the dedicated per-agent config file', () => {
    const aid = 'assignments-route.agentid.pub';
    const channelKey = 'aun#assignments-route.agentid.pub#main';
    setRoleAssignment(aid, channelKey, 'peer.agentid.pub', 'owner');

    expect(read<any>(ConfigTarget.RoleAssignments, { self: aid })?.assignments[`${channelKey}::peer.agentid.pub`].role).toBe('owner');
    expect(fs.existsSync(path.join(resolvePaths().agentsDir, aid, 'role-assignments.json'))).toBe(true);
  });

  it('uses one flush delay default constant for seconds and milliseconds', () => {
    expect(DEFAULT_FLUSH_DELAY_SECONDS).toBe(3);
    expect(DEFAULT_FLUSH_DELAY_MS).toBe(3000);
  });

  it('includes behavior files in managed config snapshots', () => {
    const sel = { self: 'snap.agentid.pub', peerKey: 'aun#peer.agentid.pub' };
    write(ConfigTarget.Agent, { aid: 'snap.agentid.pub', channels: [] }, { self: sel.self });
    write(ConfigTarget.Behavior, { dispatch: 'mention' }, { self: sel.self });
    write(ConfigTarget.Relation, { models: { default: 'x' } }, sel);
    write(ConfigTarget.RelationBehavior, { permissionMode: 'readonly' }, sel);

    const files = collectConfigFiles(resolvePaths().root);
    expect(files).toContain('agents/snap.agentid.pub/config.json');
    expect(files).toContain('agents/snap.agentid.pub/behavior.json');
    expect(files).toContain('agents/snap.agentid.pub/relations/aun#peer.agentid.pub/config.json');
    expect(files).toContain('agents/snap.agentid.pub/relations/aun#peer.agentid.pub/behavior.json');
  });

  it('can read canonical behavior target directly', () => {
    const sel = { self: 'read.agentid.pub' };
    write(ConfigTarget.Behavior, { show_activities: 'none' }, sel);
    expect(read<any>(ConfigTarget.Behavior, sel)?.show_activities).toBe('none');
  });
});
