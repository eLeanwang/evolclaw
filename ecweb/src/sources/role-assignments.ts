/**
 * Role Assignments 数据源 — Agent 角色分配和对端关系管理
 *
 * 功能：
 * 1. 管理 Agent 级别的角色分配 (owners/admins/members)
 * 2. 管理 Relation 级别的角色覆盖
 * 3. 列出所有关系及其有效角色
 *
 * 数据流：
 * - 轮询模式（2秒间隔）
 * - JSON diff 检测变化
 * - 仅在变化时推送
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import type { WatchSource } from './types.js';

// 动态导入 evolclaw 主项目的配置模块
// 注意：ecweb 是 evolclaw 的 peerDependency，运行时 resolves 到父项目
async function getConfigManager() {
  try {
    // 尝试从父项目导入
    const parentPath = path.join(process.cwd(), 'dist', 'config', 'config-manager.js');
    if (fs.existsSync(parentPath)) {
      // Windows 上需要转换为 file:// URL
      const moduleUrl = process.platform === 'win32'
        ? new URL('file:///' + parentPath.replace(/\\/g, '/')).href
        : parentPath;
      const mod = await import(moduleUrl);
      return { read: mod.read, write: mod.write, ConfigTarget: mod.ConfigTarget };
    }
  } catch (err) {
    console.warn('[role-assignments] Failed to import config-manager from parent:', err);
  }

  throw new Error('ConfigManager not found. Is evolclaw built?');
}

async function getRoleResolver() {
  try {
    const parentPath = path.join(process.cwd(), 'dist', 'config', 'role-resolver.js');
    if (fs.existsSync(parentPath)) {
      // Windows 上需要转换为 file:// URL
      const moduleUrl = process.platform === 'win32'
        ? new URL('file:///' + parentPath.replace(/\\/g, '/')).href
        : parentPath;
      const mod = await import(moduleUrl);
      return { resolveUserRole: mod.resolveUserRole };
    }
  } catch (err) {
    console.warn('[role-assignments] Failed to import role-resolver from parent:', err);
  }

  throw new Error('RoleResolver not found. Is evolclaw built?');
}

interface RolesSnapshot {
  agents: Array<{
    aid: string;
    displayName?: string;
    name?: string;
    owners: string[];
    admins: string[];
    members: string[];
  }>;
  relations: Array<{
    self: string;
    peerKey: string;
    peerAid: string;          // 裸对端 AID（私聊）或 groupId（群聊）
    peerName?: string;        // 对端昵称 / 群名称
    peerType?: string;        // ai/human/unknown
    isAgent?: boolean;        // 是否是 agent
    verifyStatus?: string;    // verified/invalid/agentmd-unverified/unknown
    chatType?: 'private' | 'group';  // 会话类型
    role: string;
    source: 'agent' | 'relation';
  }>;
}

async function buildSnapshot(): Promise<RolesSnapshot> {
  const agents: RolesSnapshot['agents'] = [];
  const relations: RolesSnapshot['relations'] = [];

  try {
    const { read, ConfigTarget } = await getConfigManager();
    const { resolveUserRole } = await getRoleResolver();
    const p = resolvePaths();

    // 从 IPC 获取 agents 列表（与 agents tab 一致）
    const { ipcQuery } = await import('../ipc-client.js');
    const agentsResp = await ipcQuery<{ ok: boolean; agents: any[] }>(
      p.socket,
      { type: 'evolagent.list' },
      3000
    );

    const agentList = agentsResp?.agents ?? [];
    console.log('[roles] Retrieved agents from IPC:', agentList.length);

    // 使用 IPC 返回的 agents 列表
    for (const agentInfo of agentList) {
      const aid = agentInfo.aid;
      if (!aid) continue;

      try {
        const config = read(ConfigTarget.Agent, { self: aid });
        agents.push({
          aid,
          // 昵称：与 agents tab 一致，优先 displayName / name
          displayName: agentInfo.displayName ?? agentInfo.personalName,
          name: agentInfo.name,
          owners: config?.owners ?? [],
          admins: config?.admins ?? [],
          members: config?.members ?? []
        });

        // 扫描该 agent 的所有会话（从 sessions 目录）
        const sessionsDir = path.join(p.root, 'data', 'sessions', 'aun', aid);

        if (fs.existsSync(sessionsDir)) {
          const peers = fs.readdirSync(sessionsDir);

          for (const peerDirName of peers) {
            // 跳过系统目录
            if (peerDirName.startsWith('_')) continue;

            const peerPath = path.join(sessionsDir, peerDirName);

            try {
              const peerStat = fs.statSync(peerPath);
              if (!peerStat.isDirectory()) continue;
            } catch {
              continue;
            }

            // 读取 active.json 获取会话元信息（权威数据源）
            const activeJsonPath = path.join(peerPath, 'active.json');
            let activeMeta: any = null;
            if (fs.existsSync(activeJsonPath)) {
              try {
                activeMeta = JSON.parse(fs.readFileSync(activeJsonPath, 'utf-8'));
              } catch (err) {
                console.warn(`[roles] Failed to read active.json for ${peerDirName}:`, err);
              }
            }

            // 判断会话类型（私聊/群聊）
            const chatType: 'private' | 'group' = activeMeta?.chatType === 'group' ? 'group' : 'private';

            try {
              if (chatType === 'group') {
                // ── 群聊处理 ──
                const groupId = activeMeta?.metadata?.groupId || decodeURIComponent(peerDirName);
                const groupName = activeMeta?.metadata?.groupName || groupId;

                // 群聊用 peerKey 解析角色（channelId = groupId）
                const peerKey = `aun#${groupId}`;
                const role = resolveUserRole(aid, groupId);
                const relationConfig = read(ConfigTarget.Relation, { self: aid, peerKey });

                relations.push({
                  self: aid,
                  peerKey,
                  peerAid: groupId,
                  peerName: groupName,
                  peerType: 'group',
                  isAgent: false,
                  verifyStatus: 'group', // 群聊无验签概念
                  chatType: 'group',
                  role,
                  source: relationConfig?.role ? 'relation' : 'agent'
                });
              } else {
                // ── 私聊处理 ──
                const peerAid = activeMeta?.channelId || decodeURIComponent(peerDirName);

                // 优先用 active.json 的 peerName，否则从 agent.md 读取
                let finalType = 'unknown';
                let finalName: string | undefined = activeMeta?.metadata?.peerName;
                let verifyStatus = 'unknown';

                const localAgentMdPath = path.join(p.root, 'AIDs', peerAid, 'agent.md');
                const agentmdJsonPath = path.join(p.root, 'AIDs', peerAid, 'agentmd.json');

                // 读取 agent.md 获取 type 和 name
                if (fs.existsSync(localAgentMdPath)) {
                  try {
                    const agentMdContent = fs.readFileSync(localAgentMdPath, 'utf-8');
                    const typeMatch = agentMdContent.match(/^type:\s*["']?([^"'\n]+?)["']?\s*$/m);
                    const nameMatch = agentMdContent.match(/^name:\s*["']?(.+?)["']?\s*$/m);
                    if (typeMatch?.[1]) finalType = typeMatch[1];
                    if (!finalName && nameMatch?.[1]) finalName = nameMatch[1]?.trim();
                  } catch (err) {
                    console.warn(`[roles] Failed to read agent.md for ${peerAid}:`, err);
                  }
                }

                // 读取验签状态
                if (fs.existsSync(agentmdJsonPath)) {
                  try {
                    const agentmdMeta = JSON.parse(fs.readFileSync(agentmdJsonPath, 'utf-8'));
                    verifyStatus = agentmdMeta.verify_status || 'unknown';
                  } catch (err) {
                    console.warn(`[roles] Failed to read agentmd.json for ${peerAid}:`, err);
                  }
                }

                const role = resolveUserRole(aid, peerAid);
                const peerKey = `aun#${peerAid}`;
                const relationConfig = read(ConfigTarget.Relation, { self: aid, peerKey });

                relations.push({
                  self: aid,
                  peerKey,
                  peerAid,
                  peerName: finalName,
                  peerType: finalType,
                  isAgent: finalType !== 'human',
                  verifyStatus,
                  chatType: 'private',
                  role,
                  source: relationConfig?.role ? 'relation' : 'agent'
                });
              }
            } catch (err) {
              console.warn(`[roles] Failed to process peer ${peerDirName}:`, err);
            }
          }
        }
      } catch (err) {
        // 跳过无法读取的 agent
        console.warn(`[roles] Failed to read agent ${aid}:`, err);
      }
    }

    console.log('[roles] Snapshot built:', agents.length, 'agents,', relations.length, 'relations');
  } catch (err) {
    console.error('[roles] Failed to build snapshot:', err);
  }

  return { agents, relations };
}

export const roleAssignmentsSource: WatchSource = {
  kind: 'roles',

  async snapshot(): Promise<RolesSnapshot> {
    return buildSnapshot();
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
        console.error('[roles] Polling error:', err);
      }
    };

    // 立即执行一次
    tick();

    const timer = setInterval(tick, 2000); // 2秒轮询
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
};

// HTTP API 处理器
export async function handleRoleAssignmentsApi(req: any, res: any): Promise<void> {
  try {
    const { read, write, ConfigTarget } = await getConfigManager();

    if (req.method === 'GET' && req.url?.startsWith('/api/roles/agent/')) {
      // GET /api/roles/agent/{aid}
      const parts = req.url.split('/');
      const aid = parts[parts.length - 1] || parts[parts.length - 2];

      if (!aid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing agent ID' }));
        return;
      }

      const config = read(ConfigTarget.Agent, { self: aid });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        owners: config?.owners ?? [],
        admins: config?.admins ?? [],
        members: config?.members ?? []
      }));
      return;
    }

    if (req.method === 'POST' && req.url?.startsWith('/api/roles/agent/')) {
      // POST /api/roles/agent/{aid}
      // Body: { field: 'owners'|'admins'|'members', users: string[] }
      const parts = req.url.split('/');
      const aid = parts[parts.length - 1] || parts[parts.length - 2];

      if (!aid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing agent ID' }));
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const { field, users } = JSON.parse(body);

          if (!field || !Array.isArray(users)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
            return;
          }

          if (!['owners', 'admins', 'members'].includes(field)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid field' }));
            return;
          }

          const config = read(ConfigTarget.Agent, { self: aid }) || {};
          config[field] = users;
          write(ConfigTarget.Agent, { self: aid }, config);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 新增：对端角色管理 API
export async function handlePeerRoleApi(req: any, res: any): Promise<void> {
  try {
    const { read, write, ConfigTarget } = await getConfigManager();

    // PUT /api/assignments/peer/:aid/:peerKey - 设置 relation 级别角色
    if (req.method === 'PUT' && req.url?.startsWith('/api/assignments/peer/')) {
      const parts = req.url.split('/').filter(Boolean);
      // parts: ['api', 'assignments', 'peer', aid, peerKey]
      if (parts.length < 5) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing aid or peerKey' }));
        return;
      }

      const aid = decodeURIComponent(parts[3]);
      const peerKey = decodeURIComponent(parts[4]);

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const { role } = JSON.parse(body);

          // 读取 relation config
          const config = read(ConfigTarget.Relation, { self: aid, peerKey }) || {};

          if (role === null || role === '') {
            // 移除覆盖
            delete config.role;
          } else {
            // 设置覆盖
            if (!['owner', 'admin', 'member'].includes(role)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid role' }));
              return;
            }
            config.role = role;
          }

          // 保存
          write(ConfigTarget.Relation, { self: aid, peerKey }, config);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // DELETE /api/assignments/peer/:aid/:peerKey - 移除 relation 级别角色覆盖
    if (req.method === 'DELETE' && req.url?.startsWith('/api/assignments/peer/')) {
      const parts = req.url.split('/').filter(Boolean);
      if (parts.length < 5) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing aid or peerKey' }));
        return;
      }

      const aid = decodeURIComponent(parts[3]);
      const peerKey = decodeURIComponent(parts[4]);

      // 读取 relation config
      const config = read(ConfigTarget.Relation, { self: aid, peerKey }) || {};
      delete config.role;

      // 保存
      write(ConfigTarget.Relation, { self: aid, peerKey }, config);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}
