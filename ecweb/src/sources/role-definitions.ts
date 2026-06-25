/**
 * Role Definitions 数据源 — 管理角色定义及其权限配置
 *
 * 功能：
 * 1. 读取 roles.json 或内置角色配置
 * 2. 提供角色定义的 CRUD API
 * 3. WebSocket 推送角色配置变化
 *
 * 数据流：
 * - 读取：从 evolclaw/dist/config/roles.ts 导入 readRolesConfig
 * - 写入：保存到 .evolclaw/roles.json
 * - 推送：2秒轮询 + JSON diff
 */

import fs from 'fs';
import path from 'path';
import type { WatchSource } from './types.js';

// 动态导入 evolclaw 主项目的角色配置模块
async function getRolesModule() {
  const rolesPath = path.join(process.cwd(), 'dist', 'config', 'roles.js');
  const cmPath = path.join(process.cwd(), 'dist', 'config', 'config-manager.js');

  if (!fs.existsSync(rolesPath) || !fs.existsSync(cmPath)) {
    throw new Error(`Roles modules not found (roles.js / config-manager.js). Is evolclaw built? cwd=${process.cwd()}`);
  }

  // Windows 上需要转换为 file:// URL
  const toUrl = (p: string) => process.platform === 'win32'
    ? new URL('file:///' + p.replace(/\\/g, '/')).href
    : p;

  try {
    const rolesMod = await import(toUrl(rolesPath));
    const cmMod = await import(toUrl(cmPath));

    if (!rolesMod.readRolesConfig) throw new Error('readRolesConfig not found in roles.js');
    if (!rolesMod.getBuiltinRolesConfig) throw new Error('getBuiltinRolesConfig not found in roles.js');
    if (!cmMod.writeRoles) throw new Error('writeRoles not found in config-manager.js');

    return {
      readRolesConfig: rolesMod.readRolesConfig as () => any,
      getBuiltinRolesConfig: rolesMod.getBuiltinRolesConfig as () => any,
      writeRoles: cmMod.writeRoles as (full: any) => void,
    };
  } catch (err) {
    console.error('[role-definitions] Failed to import roles modules:', err);
    throw err;
  }
}

async function buildSnapshot(): Promise<any> {
  try {
    const { readRolesConfig } = await getRolesModule();
    return readRolesConfig();
  } catch (err) {
    console.error('[role-definitions] Failed to build snapshot:', err);
    return { $schema_version: 1, roles: {}, error: String(err) };
  }
}

export const roleDefinitionsSource: WatchSource = {
  kind: 'roleDefinitions',

  async snapshot(): Promise<any> {
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
        console.error('[role-definitions] Polling error:', err);
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
export async function handleRoleDefinitionsApi(req: any, res: any): Promise<void> {
  try {
    const { readRolesConfig, getBuiltinRolesConfig, writeRoles } = await getRolesModule();

    // GET /api/role-definitions - 获取所有角色定义
    if (req.method === 'GET' && req.url === '/api/role-definitions') {
      const config = readRolesConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }

    // POST /api/role-definitions - 创建新角色
    if (req.method === 'POST' && req.url === '/api/role-definitions') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { name, description, permissions } = data;

          if (!name || !/^[a-z0-9_-]+$/.test(name)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid role name' }));
            return;
          }

          // 读取当前配置
          const config = readRolesConfig();

          // 检查是否已存在
          if (config.roles[name]) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Role already exists' }));
            return;
          }

          // 创建新角色
          config.roles[name] = {
            description: description || '',
            permissions: permissions || {}
          };

          // 通过 ConfigManager 写入（内部算 diff，自动 schema 校验）
          writeRoles(config);

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, role: config.roles[name] }));
        } catch (err: any) {
          console.error('[role-definitions] Failed to create role:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // GET /api/role-definitions/:role - 获取单个角色定义
    if (req.method === 'GET' && req.url?.startsWith('/api/role-definitions/')) {
      const roleName = req.url.split('/').pop();
      if (!roleName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing role name' }));
        return;
      }

      const config = readRolesConfig();
      const roleDef = config.roles[roleName];

      if (!roleDef) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Role not found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(roleDef));
      return;
    }

    // DELETE /api/role-definitions/:role - 删除角色
    if (req.method === 'DELETE' && req.url?.startsWith('/api/role-definitions/')) {
      const roleName = req.url.split('/').pop();
      if (!roleName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing role name' }));
        return;
      }

      // 不允许删除内置角色
      const builtinRoles = ['owner', 'admin', 'member', 'guest', 'anonymous'];
      if (builtinRoles.includes(roleName)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cannot delete builtin role' }));
        return;
      }

      const config = readRolesConfig();

      if (!config.roles[roleName]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Role not found' }));
        return;
      }

      // 删除角色
      delete config.roles[roleName];

      // 通过 ConfigManager 写入
      writeRoles(config);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // PUT /api/role-definitions/:role - 更新角色定义
    if (req.method === 'PUT' && req.url?.startsWith('/api/role-definitions/')) {
      const parts = req.url.split('/');
      const roleName = parts[parts.length - 1];

      if (!roleName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing role name' }));
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const updates = JSON.parse(body);

          // 读取当前配置
          const config = readRolesConfig();

          if (!config.roles[roleName]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Role not found' }));
            return;
          }

          // 更新角色定义
          config.roles[roleName] = {
            ...config.roles[roleName],
            ...updates
          };

          // 通过 ConfigManager 写入（内部算 diff）
          writeRoles(config);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          console.error('[role-definitions] Failed to update role:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /api/role-definitions/:role/reset - 重置为默认配置
    if (req.method === 'POST' && req.url?.match(/\/api\/role-definitions\/[^/]+\/reset$/)) {
      const parts = req.url.split('/');
      const roleName = parts[parts.length - 2];

      if (!roleName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing role name' }));
        return;
      }

      // 获取内置默认配置
      const builtinConfig = getBuiltinRolesConfig();
      const builtinRole = builtinConfig.roles[roleName];

      if (!builtinRole) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Role not found in builtin config' }));
        return;
      }

      // 读取当前配置，将该角色设为内置默认（diff 后会从 roles.json 移除，恢复继承内置）
      const config = readRolesConfig();
      config.roles[roleName] = builtinRole;

      // 通过 ConfigManager 写入
      writeRoles(config);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: builtinRole }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err: any) {
    console.error('[role-definitions] API error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

