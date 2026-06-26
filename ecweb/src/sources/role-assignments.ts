import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import type { WatchSource } from './types.js';

interface RoleWriteAuth {
  localDirect?: boolean;
  actorAid?: string | null;
}

interface RoleAssignment {
  channelKey: string;
  peerId: string;
  role: string;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
}

function toUrl(p: string): string {
  return process.platform === 'win32'
    ? new URL('file:///' + p.replace(/\\/g, '/')).href
    : p;
}

async function getParentModules() {
  const dist = path.join(process.cwd(), 'dist', 'config');
  const assignmentsPath = path.join(dist, 'role-assignments.js');
  const rolesPath = path.join(dist, 'roles.js');
  const resolverPath = path.join(dist, 'peer-role-resolver.js');
  const cmPath = path.join(dist, 'config-manager.js');

  for (const p of [assignmentsPath, rolesPath, resolverPath, cmPath]) {
    if (!fs.existsSync(p)) throw new Error(`module not found: ${p}. Is evolclaw built?`);
  }

  const assignments = await import(toUrl(assignmentsPath));
  const roles = await import(toUrl(rolesPath));
  const resolver = await import(toUrl(resolverPath));
  const cm = await import(toUrl(cmPath));
  return { assignments, roles, resolver, cm };
}

async function getAgentsFromIpc(): Promise<any[]> {
  try {
    const p = resolvePaths();
    const { ipcQuery } = await import('../ipc-client.js');
    const resp = await ipcQuery<{ ok: boolean; agents: any[] }>(
      p.socket,
      { type: 'evolagent.list' },
      3000,
    );
    return resp?.agents ?? [];
  } catch {
    return [];
  }
}

async function canManageAgent(aid: string, auth: RoleWriteAuth): Promise<boolean> {
  if (auth.localDirect) return true;
  if (!auth.actorAid) return false;
  const { assignments } = await getParentModules();
  const config = assignments.readRoleAssignments(aid);
  return Object.values(config.assignments || {}).some((item: any) =>
    item.peerId === auth.actorAid && item.role === 'owner',
  );
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
  });
}

function sendJson(res: any, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function assignmentFromPath(urlPath: string): { aid: string; peerId: string } | null {
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length < 5) return null;
  return {
    aid: decodeURIComponent(parts[3]),
    peerId: decodeURIComponent(parts.slice(4).join('/')),
  };
}

async function buildSnapshot(): Promise<any> {
  const { assignments, resolver } = await getParentModules();
  const agents = await getAgentsFromIpc();
  const snapshotAgents: any[] = [];
  const relations: any[] = [];

  for (const agent of agents) {
    const aid = agent.aid;
    if (!aid) continue;
    const config = assignments.readRoleAssignments(aid);
    const roleItems = Object.values(config.assignments || {}) as RoleAssignment[];
    snapshotAgents.push({
      aid,
      displayName: agent.displayName ?? agent.personalName,
      name: agent.name,
      assignments: roleItems,
    });

    for (const item of roleItems) {
      const detail = resolver.resolvePeerRoleDetail({
        selfAid: aid,
        channelKey: item.channelKey,
        channelType: item.channelKey.split('#')[0] || 'aun',
        chatType: 'private',
        actorId: item.peerId,
        conversationId: item.peerId,
      });
      relations.push({
        self: aid,
        channelKey: item.channelKey,
        peerKey: item.peerId,
        peerAid: item.peerId,
        peerId: item.peerId,
        role: detail.effectiveRole,
        source: 'assignment',
        assignment: item,
      });
    }
  }

  return { agents: snapshotAgents, relations };
}

export const roleAssignmentsSource: WatchSource = {
  kind: 'roles',

  async snapshot(): Promise<any> {
    try { return await buildSnapshot(); }
    catch (err) { return { agents: [], relations: [], error: String(err) }; }
  },

  subscribe(_params: Record<string, any>, push: (data: any) => void): () => void {
    let lastJson = '';
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const snap = await buildSnapshot();
        const json = JSON.stringify(snap);
        if (json !== lastJson) {
          lastJson = json;
          push(snap);
        }
      } catch (err) {
        console.error('[role-assignments] polling error:', err);
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  },
};

export async function handleRoleAssignmentsApi(req: any, res: any, auth: RoleWriteAuth = {}): Promise<void> {
  try {
    const { assignments } = await getParentModules();
    const urlPath = (req.url || '').split('?')[0];

    if (req.method === 'GET' && urlPath.startsWith('/api/roles/agent/')) {
      const aid = decodeURIComponent(urlPath.split('/').filter(Boolean).pop() || '');
      if (!aid) return sendJson(res, 400, { error: 'missing aid' });
      return sendJson(res, 200, assignments.readRoleAssignments(aid));
    }

    if ((req.method === 'POST' || req.method === 'PUT') && urlPath.startsWith('/api/roles/agent/')) {
      const aid = decodeURIComponent(urlPath.split('/').filter(Boolean).pop() || '');
      if (!aid) return sendJson(res, 400, { error: 'missing aid' });
      if (!(await canManageAgent(aid, auth))) return sendJson(res, 403, { error: 'forbidden: owner required' });

      const body = await parseBody(req);
      const channelKey = body.channelKey || `aun#${aid}#main`;
      const peerId = body.peerId || body.user || body.aid;
      const role = body.role;
      if (!peerId || !role) return sendJson(res, 400, { error: 'peerId and role are required' });

      const item = assignments.setRoleAssignment(aid, channelKey, peerId, role, { note: body.note });
      return sendJson(res, 200, { ok: true, assignment: item });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err: any) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}

export async function handlePeerRoleApi(req: any, res: any, auth: RoleWriteAuth = {}): Promise<void> {
  try {
    const { assignments } = await getParentModules();
    const urlPath = (req.url || '').split('?')[0];
    const target = assignmentFromPath(urlPath);
    if (!target) return sendJson(res, 400, { error: 'missing aid or peerId' });
    if (!(await canManageAgent(target.aid, auth))) return sendJson(res, 403, { error: 'forbidden: owner required' });

    if (req.method === 'DELETE') {
      const body = await parseBody(req);
      const channelKey = body.channelKey;
      if (!channelKey) return sendJson(res, 400, { error: 'channelKey is required' });
      assignments.deleteRoleAssignment(target.aid, channelKey, target.peerId);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'PUT') {
      const body = await parseBody(req);
      if (!body.role) return sendJson(res, 400, { error: 'role is required' });
      if (!body.channelKey) return sendJson(res, 400, { error: 'channelKey is required' });
      const item = assignments.setRoleAssignment(target.aid, body.channelKey, target.peerId, body.role, { note: body.note });
      return sendJson(res, 200, { ok: true, assignment: item });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err: any) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
