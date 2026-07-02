# ECWeb 后端 API 开发指南

> 版本：v1.0  
> 日期：2026-06-24

---

## 📋 目录

1. [API 接口清单](#api-接口清单)
2. [完整实现代码](#完整实现代码)
3. [权限验证](#权限验证)
4. [错误处理](#错误处理)
5. [测试用例](#测试用例)

---

## API 接口清单

### 角色管理 API（3 个）

| 方法 | 路径 | 功能 | 权限 |
|------|------|------|------|
| GET | /api/agents/:agentId/roles | 获取 agent 角色列表 | 所有用户 |
| POST | /api/agents/:agentId/roles/:role | 添加用户到角色 | Owner |
| DELETE | /api/agents/:agentId/roles/:role/:userId | 移除用户角色 | Owner |

### 关系管理 API（2 个）

| 方法 | 路径 | 功能 | 权限 |
|------|------|------|------|
| GET | /api/agents/:agentId/relations | 获取关系列表 | Owner/Admin |
| GET | /api/agents/:agentId/relations/:peerKey | 获取关系详情 | Owner/Admin |

---

## 完整实现代码

### 1. 角色管理 API

```typescript
// src/api/agents/[agentId]/roles.ts
import express from 'express';
import { read, write, ConfigTarget } from '@/config/config-manager';
import { resolveUserRole } from '@/config/role-resolver';
import type { AgentConfig } from '@/types';

const router = express.Router();

/**
 * GET /api/agents/:agentId/roles
 * 获取 agent 的角色配置
 */
router.get('/agents/:agentId/roles', async (req, res) => {
  try {
    const { agentId } = req.params;

    // 读取 agent 配置
    const config = read<AgentConfig>(ConfigTarget.Agent, { self: agentId });

    if (!config) {
      return res.status(404).json({
        error: 'Agent not found',
        message: `Agent ${agentId} does not exist`,
      });
    }

    // 返回角色列表
    res.json({
      owners: config.owners || [],
      admins: config.admins || [],
      members: config.members || [],
    });
  } catch (error: any) {
    console.error('[GET /roles] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/agents/:agentId/roles/:role
 * 添加用户到角色列表
 * 
 * Body: { userId: string }
 */
router.post('/agents/:agentId/roles/:role', async (req, res) => {
  try {
    const { agentId, role } = req.params;
    const { userId } = req.body;

    // 参数验证
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'userId is required and must be a string',
      });
    }

    // 验证角色类型
    if (!['owner', 'admin', 'member'].includes(role)) {
      return res.status(400).json({
        error: 'Invalid role',
        message: 'Role must be one of: owner, admin, member',
      });
    }

    // 验证 AID 格式
    if (!/^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(userId)) {
      return res.status(400).json({
        error: 'Invalid AID format',
        message: 'userId must be a valid AID (e.g., alice.aid.pub)',
      });
    }

    // 权限检查：只有 owner 可以修改角色
    const currentUserRole = resolveUserRole(agentId, req.user.id);
    if (currentUserRole !== 'owner') {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: 'Only owners can manage roles',
      });
    }

    // 读取配置
    let config = read<AgentConfig>(ConfigTarget.Agent, { self: agentId });
    
    if (!config) {
      // 如果 agent 不存在，创建基础配置
      config = {
        aid: agentId,
        channels: [],
        owners: [],
        admins: [],
        members: [],
      };
    }

    // 添加到对应角色列表
    const roleKey = `${role}s` as 'owners' | 'admins' | 'members';
    if (!config[roleKey]) {
      config[roleKey] = [];
    }

    if (config[roleKey]!.includes(userId)) {
      return res.status(409).json({
        error: 'User already exists',
        message: `${userId} is already in ${role}s`,
      });
    }

    config[roleKey]!.push(userId);

    // 写入配置
    write(ConfigTarget.Agent, config, { self: agentId });

    res.json({
      success: true,
      message: `Added ${userId} to ${role}s`,
    });
  } catch (error: any) {
    console.error('[POST /roles] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/agents/:agentId/roles/:role/:userId
 * 从角色列表移除用户
 */
router.delete('/agents/:agentId/roles/:role/:userId', async (req, res) => {
  try {
    const { agentId, role, userId } = req.params;

    // 验证角色类型
    if (!['owner', 'admin', 'member'].includes(role)) {
      return res.status(400).json({
        error: 'Invalid role',
        message: 'Role must be one of: owner, admin, member',
      });
    }

    // 权限检查
    const currentUserRole = resolveUserRole(agentId, req.user.id);
    if (currentUserRole !== 'owner') {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: 'Only owners can manage roles',
      });
    }

    // 防止删除最后一个 owner
    if (role === 'owner') {
      const config = read<AgentConfig>(ConfigTarget.Agent, { self: agentId });
      if (config?.owners?.length === 1 && config.owners[0] === userId) {
        return res.status(400).json({
          error: 'Cannot remove last owner',
          message: 'At least one owner is required',
        });
      }
    }

    // 读取配置
    const config = read<AgentConfig>(ConfigTarget.Agent, { self: agentId });
    
    if (!config) {
      return res.status(404).json({
        error: 'Agent not found',
        message: `Agent ${agentId} does not exist`,
      });
    }

    // 从角色列表移除
    const roleKey = `${role}s` as 'owners' | 'admins' | 'members';
    if (config[roleKey]) {
      config[roleKey] = config[roleKey]!.filter(id => id !== userId);
    }

    // 写入配置
    write(ConfigTarget.Agent, config, { self: agentId });

    res.json({
      success: true,
      message: `Removed ${userId} from ${role}s`,
    });
  } catch (error: any) {
    console.error('[DELETE /roles] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
```

---

### 2. 关系管理 API

```typescript
// src/api/agents/[agentId]/relations.ts
import express from 'express';
import fs from 'fs';
import path from 'path';
import { agentRelationsDir } from '@/paths';
import { resolveUserRole } from '@/config/role-resolver';
import { parsePeerKey } from '@/core/relation/peer-identity';
import { resolveEffective } from '@/config/config-manager';

const router = express.Router();

/**
 * GET /api/agents/:agentId/relations
 * 获取 agent 的所有关系列表
 */
router.get('/agents/:agentId/relations', async (req, res) => {
  try {
    const { agentId } = req.params;

    // 权限检查：owner 或 admin 可以查看
    const currentUserRole = resolveUserRole(agentId, req.user.id);
    if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: 'Only owners and admins can view relations',
      });
    }

    // 读取 relations 目录
    const relationsPath = agentRelationsDir(agentId);

    if (!fs.existsSync(relationsPath)) {
      return res.json([]);
    }

    const peerKeys = fs.readdirSync(relationsPath);

    const relations = peerKeys
      .map(peerKey => {
        try {
          // 解析 peerKey
          const { channelType, channelId } = parsePeerKey(peerKey);

          // 解析角色
          const role = resolveUserRole(agentId, peerKey);

          // 检查是否有显式配置
          const hasExplicitConfig = 
            fs.existsSync(path.join(relationsPath, peerKey, 'config.json')) ||
            fs.existsSync(path.join(relationsPath, peerKey, 'behavior.json'));

          return {
            peerKey,
            peerId: channelId,
            channelType,
            role,
            roleSource: hasExplicitConfig ? 'explicit' : 'agent',
          };
        } catch (error) {
          console.warn(`Failed to process relation ${peerKey}:`, error);
          return null;
        }
      })
      .filter(Boolean);

    res.json(relations);
  } catch (error: any) {
    console.error('[GET /relations] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/agents/:agentId/relations/:peerKey
 * 获取单个关系的详细信息
 */
router.get('/agents/:agentId/relations/:peerKey', async (req, res) => {
  try {
    const { agentId, peerKey } = req.params;

    // 权限检查
    const currentUserRole = resolveUserRole(agentId, req.user.id);
    if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: 'Only owners and admins can view relation details',
      });
    }

    // 解码 peerKey
    const decodedPeerKey = decodeURIComponent(peerKey);

    // 解析 peerKey
    const { channelType, channelId } = parsePeerKey(decodedPeerKey);

    // 解析角色
    const role = resolveUserRole(agentId, decodedPeerKey);

    // 获取有效配置
    const effectiveConfig = resolveEffective({
      self: agentId,
      peerKey: decodedPeerKey,
      role,
    });

    // 检查是否有显式配置
    const relationsPath = agentRelationsDir(agentId);
    const hasExplicitConfig = 
      fs.existsSync(path.join(relationsPath, decodedPeerKey, 'config.json')) ||
      fs.existsSync(path.join(relationsPath, decodedPeerKey, 'behavior.json'));

    res.json({
      peerKey: decodedPeerKey,
      peerId: channelId,
      channelType,
      role,
      roleSource: hasExplicitConfig ? 'explicit' : 'agent',
      effectiveConfig: {
        permissionMode: effectiveConfig.permissionMode,
        model: effectiveConfig.baseagents?.claude?.model,
        effort: effectiveConfig.baseagents?.claude?.effort,
        dispatch: effectiveConfig.dispatch,
        chatmode: effectiveConfig.chatmode,
        showActivities: effectiveConfig.show_activities,
      },
    });
  } catch (error: any) {
    console.error('[GET /relations/:peerKey] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
```

---

### 3. 认证中间件

```typescript
// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface User {
  id: string;  // AID
  name?: string;
}

declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}

/**
 * 认证中间件
 * 验证 JWT token 并解析用户信息
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication token is required',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as User;
    req.user = decoded;

    next();
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token expired',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
```

---

### 4. 权限检查中间件

```typescript
// src/middleware/permission.ts
import { Request, Response, NextFunction } from 'express';
import { resolveUserRole } from '@/config/role-resolver';
import type { RoleName } from '@/types/roles';

/**
 * 权限检查中间件工厂
 * 
 * @param minimumRole 最低要求角色
 * @returns Express 中间件
 */
export function requireRole(minimumRole: RoleName) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { agentId } = req.params;
      const userId = req.user.id;

      const userRole = resolveUserRole(agentId, userId);

      const roleRank: Record<RoleName, number> = {
        anonymous: 0,
        guest: 1,
        member: 2,
        admin: 3,
        owner: 4,
      };

      if (roleRank[userRole] >= roleRank[minimumRole]) {
        next();
      } else {
        res.status(403).json({
          error: 'Insufficient permissions',
          message: `This operation requires ${minimumRole} role or higher. You are ${userRole}.`,
        });
      }
    } catch (error: any) {
      console.error('[requireRole] Error:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: error.message,
      });
    }
  };
}

/**
 * 使用示例
 * 
 * router.post('/agents/:agentId/roles/:role',
 *   authenticate,
 *   requireRole('owner'),
 *   async (req, res) => {
 *     // 只有 owner 可以执行
 *   }
 * );
 */
```

---

### 5. 路由注册

```typescript
// src/app.ts
import express from 'express';
import { authenticate } from '@/middleware/auth';
import rolesRouter from '@/api/agents/[agentId]/roles';
import relationsRouter from '@/api/agents/[agentId]/relations';

const app = express();

// 中间件
app.use(express.json());
app.use(authenticate);  // 全局认证

// 路由
app.use('/api', rolesRouter);
app.use('/api', relationsRouter);

// 错误处理
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

export default app;
```

---

## 权限验证

### 权限矩阵

| API | Anonymous | Guest | Member | Admin | Owner |
|-----|-----------|-------|--------|-------|-------|
| GET /roles | ❌ | ❌ | ❌ | ✅ | ✅ |
| POST /roles/:role | ❌ | ❌ | ❌ | ❌ | ✅ |
| DELETE /roles/:role/:userId | ❌ | ❌ | ❌ | ❌ | ✅ |
| GET /relations | ❌ | ❌ | ❌ | ✅ | ✅ |
| GET /relations/:peerKey | ❌ | ❌ | ❌ | ✅ | ✅ |

### 特殊规则

1. **最后一个 Owner**: 不能删除最后一个 owner
2. **自我操作**: Owner 不能将自己从 owners 列表中移除（如果是最后一个）
3. **角色升级**: 只有 owner 可以添加新 owner
4. **角色降级**: 只有 owner 可以移除其他角色

---

## 错误处理

### 错误码规范

```typescript
// src/types/errors.ts
export enum ErrorCode {
  // 认证错误 (401)
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',

  // 权限错误 (403)
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',

  // 请求错误 (400)
  INVALID_REQUEST = 'INVALID_REQUEST',
  INVALID_ROLE = 'INVALID_ROLE',
  INVALID_AID_FORMAT = 'INVALID_AID_FORMAT',
  CANNOT_REMOVE_LAST_OWNER = 'CANNOT_REMOVE_LAST_OWNER',

  // 资源错误 (404)
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  USER_NOT_FOUND = 'USER_NOT_FOUND',

  // 冲突错误 (409)
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',

  // 服务器错误 (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface APIError {
  error: ErrorCode;
  message: string;
  details?: any;
}
```

### 错误响应格式

```json
{
  "error": "INSUFFICIENT_PERMISSIONS",
  "message": "Only owners can manage roles",
  "details": {
    "requiredRole": "owner",
    "currentRole": "admin"
  }
}
```

---

## 测试用例

### API 测试

```typescript
// tests/api/roles.test.ts
import request from 'supertest';
import app from '@/app';
import { generateToken } from '@/utils/jwt';

describe('Roles API', () => {
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;

  beforeAll(() => {
    ownerToken = generateToken({ id: 'owner.aid.pub' });
    adminToken = generateToken({ id: 'admin.aid.pub' });
    memberToken = generateToken({ id: 'member.aid.pub' });
  });

  describe('GET /api/agents/:agentId/roles', () => {
    it('should return roles list for authenticated user', async () => {
      const res = await request(app)
        .get('/api/agents/test-agent/roles')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('owners');
      expect(res.body).toHaveProperty('admins');
      expect(res.body).toHaveProperty('members');
    });

    it('should return 401 without token', async () => {
      const res = await request(app)
        .get('/api/agents/test-agent/roles');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/agents/:agentId/roles/:role', () => {
    it('should add user to role as owner', async () => {
      const res = await request(app)
        .post('/api/agents/test-agent/roles/admin')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: 'new-user.aid.pub' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject non-owner', async () => {
      const res = await request(app)
        .post('/api/agents/test-agent/roles/admin')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: 'new-user.aid.pub' });

      expect(res.status).toBe(403);
    });

    it('should validate AID format', async () => {
      const res = await request(app)
        .post('/api/agents/test-agent/roles/admin')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: 'invalid-id' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_AID_FORMAT');
    });
  });

  describe('DELETE /api/agents/:agentId/roles/:role/:userId', () => {
    it('should remove user from role as owner', async () => {
      const res = await request(app)
        .delete('/api/agents/test-agent/roles/admin/old-user.aid.pub')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should prevent removing last owner', async () => {
      const res = await request(app)
        .delete('/api/agents/test-agent/roles/owner/owner.aid.pub')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CANNOT_REMOVE_LAST_OWNER');
    });
  });
});
```

---

## 性能优化

### 缓存策略

```typescript
// src/utils/cache.ts
import NodeCache from 'node-cache';

const cache = new NodeCache({
  stdTTL: 60,  // 60 秒过期
  checkperiod: 120,
});

export function getCachedRoles(agentId: string) {
  return cache.get(`roles:${agentId}`);
}

export function setCachedRoles(agentId: string, roles: any) {
  cache.set(`roles:${agentId}`, roles);
}

export function invalidateRolesCache(agentId: string) {
  cache.del(`roles:${agentId}`);
}
```

### 批量操作

```typescript
/**
 * POST /api/agents/:agentId/roles/batch
 * 批量添加用户到角色
 * 
 * Body: {
 *   operations: [
 *     { action: 'add', role: 'admin', userId: 'user1.aid.pub' },
 *     { action: 'remove', role: 'member', userId: 'user2.aid.pub' }
 *   ]
 * }
 */
router.post('/agents/:agentId/roles/batch', async (req, res) => {
  // 实现批量操作
  // ...
});
```

---

**文档维护**: Claude (Opus 4.8)  
**创建日期**: 2026-06-24  
**最后更新**: 2026-06-24
