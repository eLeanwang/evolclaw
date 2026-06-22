# 专题 · 权限与授权

> **本文是权限模型的单一事实源（SSOT）**。chmod / setfacl / token / 角色 / 权限求值顺序，全部在此定义。其他文档只引用，不复述。

---

## 【使用】

### 心智模型：三层权限，从粗到细

```
角色权限（群内粗粒度）
    ↓ 更细
文件权限（chmod，管可见性）
    ↓ 更细
AID 白名单（setfacl，给具体 AID 授权）
    +
访问令牌（token，给无身份的 HTTP 访问者）
```

**永远只有一套鉴权**——collab 协作、群共享、对外分享全走这套，无特权通道。

### 角色权限（群内）

| 角色 | ls/cat | cp上传 | mkdir | mv/rm | chmod/setfacl | approve |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| member | ✅ | ✅（仅自己 memberdata） | ✅ | ❌ | ❌ | ❌ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 外部（公开文件） | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

个人 storage：仅 AID 持有人可写；公开文件（chmod +r）任何人可读。

### chmod（改可见性和角色约束）

```bash
ec fs chmod +r <AID>:<path>                    # 公开可读
ec fs chmod o-r <AID>:<path>                   # 收回他人读权限
ec fs chmod <AID>:<path> --allow-roles admin   # 限定角色
ec fs chmod <AID>:<path> --visibility public|private
```

`chmod` 只管权限位和可见性，**不签发凭证、不处理 AID 白名单**。

### setfacl（给具体 AID 授权）

```bash
ec fs setfacl -m aid:bob.aid.pub:r   <AID>:<path>                        # 只读
ec fs setfacl -m aid:bob.aid.pub:rw  <AID>:<path> --expires 2026-12-01   # 读写+期限
ec fs setfacl -m aid:bob.aid.pub:rw  <AID>:<path> --max-uses 100         # 限次数
ec fs setfacl -x aid:bob.aid.pub     <AID>:<path>                        # 撤销
```

**ACL 继承**：对前缀（目录）授权，其下现存与新建对象默认继承；子路径的具体条目可覆盖父级（取最近祖先）。

> **这是协作授权的唯一机制**：「谁能 collab submit」≡「谁对 collabRoot 有写权限」。collab 无特权通道。

### token（给无身份访问者）

```bash
ec fs token issue  <AID>:<path> [--expires 2026-12-01] [--max-reads 10]
ec fs token revoke <AID>:<path> --token tok_abc123
ec fs token ls     <AID>:<path>
```

token 两侧通用（CLI 带 `--token`，HTTP 带 `Authorization: Bearer`）。吊销立即生效。

### 统一权限求值顺序

**访问任意资源时，按此顺序求值，命中即放行：**

```
1. 公开位（chmod +r / is_public）    → 命中且操作=读 → 放行
2. token（若请求携带）               → 有效且覆盖该操作 → 放行；过期/吊销 → 拒绝
3. 细粒度 ACL（setfacl，按请求者 AID）→ 命中且 perms 覆盖 → 放行
4. 角色权限（群内，按请求者角色）      → 角色覆盖该操作 → 放行
5. owner（资源所在命名空间归属者）    → 总是放行
6. 以上全不命中                       → EACCES
```

顺序是硬顺序，不可调换。token 在 ACL 之前是为了支持「私有文件 + token 临时分享」场景（token 有效则放行，不要求访问者在 AID 白名单内）。

---

## 【实现】

### CLI 实现者

**chmod** 解析：提取 `<AID>:<path>`，把 `+r`/`o-r`/`--visibility`/`--allow-roles` 转成 SDK 对应字段调用，不混入 ACL 条目。

**setfacl** 解析：
- `-m aid:<AID>:<perms>` → upsert ACL 条目
- `-x aid:<AID>` → delete ACL 条目
- `<perms>` 合法值：`r`（只读）/ `w`（只写）/ `rw`（读写）/ `rwx`（含删除）
- 选项 `--expires <ISO date>`、`--max-uses <n>` → 附在条目上
- 操作对象是前缀路径时，实现为「目录级 ACL」（后端 default ACL 语义）

**token** 解析：issue/revoke/ls 三个子命令，issue 返回 token 串并提示两种使用方式（CLI `--token` / HTTP Bearer）。

### SDK 设计者

```
// chmod
storage.setVisibility({ path, requesterAid, visibility: "public"|"private", allowRoles? })

// setfacl
storage.setAcl({ path, requesterAid, aid: "<aid>", perms: "r"|"rw"|"rwx", expires?, maxUses? })
storage.removeAcl({ path, requesterAid, aid: "<aid>" })
storage.listAcl({ path, requesterAid }) → [{aid, perms, expires, maxUses, usedCount}]

// token
storage.issueToken({ path, requesterAid, expires?, maxReads? }) → { token, path, expires, maxReads }
storage.revokeToken({ path, token, requesterAid })
storage.listTokens({ path, requesterAid }) → [{token, expires, maxReads, usedCount}]

// 权限校验（内部）：后端执行上述求值顺序
storage.checkAccess({ path, requesterAid, operation: "read"|"write"|"delete", token? })
  → { allowed: true } | { allowed: false, reason: "EACCES"|"EDANGLING"|"volume_expired" }
```

### AUN 后端实现者

**表结构**：

```sql
-- 细粒度 ACL
CREATE TABLE path_acls (
  owner_aid   TEXT NOT NULL,
  path_prefix TEXT NOT NULL,        -- 目录级 ACL 用 prefix（以 / 结尾）
  grantee_aid TEXT NOT NULL,
  perms       TEXT NOT NULL,        -- r | rw | rwx
  expires     TIMESTAMP,
  max_uses    INT,
  used_count  INT DEFAULT 0,
  PRIMARY KEY (owner_aid, path_prefix, grantee_aid)
);

-- 访问令牌
CREATE TABLE access_tokens (
  token       TEXT PRIMARY KEY,
  owner_aid   TEXT NOT NULL,
  path        TEXT NOT NULL,
  expires     TIMESTAMP,
  max_reads   INT,
  read_count  INT DEFAULT 0,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP
);
```

**权限求值实现**（伪代码）：

```python
def check_access(path, requester_aid, operation, token=None):
    # 1. 公开位
    if is_public(path) and operation == "read":
        return ALLOW

    # 2. token
    if token:
        t = lookup_token(token)
        if not t or t.revoked or t.expired:
            return DENY("token_invalid")
        if t.path == path and covers(t, operation):
            return ALLOW

    # 3. 细粒度 ACL（最近祖先前缀匹配）
    acl = find_nearest_acl(path, requester_aid)
    if acl and covers(acl.perms, operation):
        if acl.expires and now() > acl.expires:
            return DENY("acl_expired")
        if acl.max_uses and acl.used_count >= acl.max_uses:
            return DENY("acl_exhausted")
        increment_used_count(acl)
        return ALLOW

    # 4. 角色（群内）
    role = get_group_role(path, requester_aid)   # 仅群命名空间有效
    if role and role_covers(role, operation):
        return ALLOW

    # 5. owner
    if is_owner(path, requester_aid):
        return ALLOW

    return DENY("EACCES")
```

**ACL 前缀继承的查找**（find_nearest_acl）：
从目标 path 向上逐级截取前缀，查 `path_acls` 表中 `path_prefix` 匹配的条目，取**最长匹配**（最近祖先）。这决定了子路径的具体授权能覆盖父级授权。
