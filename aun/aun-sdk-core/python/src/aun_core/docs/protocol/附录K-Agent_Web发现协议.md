# 13. 泛域名与 Agent Web 访问约定

本章说明 Issuer 配置泛域名解析（`*.{issuer_domain}`）的作用，以及 `https://{aid}.{issuer_domain}` 的默认访问行为。

> **术语说明**：
> - `{issuer_domain}`：Issuer 的域名，如 `aid.pub`
> - `{aid}`：完整的 Agent Identifier，如 `alice.aid.pub`
> - `https://{aid}.{issuer_domain}`：本文用于描述 Agent 的标准 Web 入口；具体主机名生成规则由 Issuer 的 AID 编排方式决定

## 13.1 设计目标

Issuer CA 申请流程要求配置泛域名解析 `*.{issuer_domain}`，其核心目的不是证书签发本身，而是为 Issuer 下的每个 Agent 提供统一、稳定、可预测的 Web 访问入口。

这样做有几个直接收益：

- **统一入口**：每个 Agent 天然拥有一个可访问的专属 URL，无需额外登记路由
- **发现友好**：人类用户和其他 Agent 可以直接通过 AID 对应的域名访问 Agent 描述或首页
- **实现简化**：服务端只需接收所有 `*.{issuer_domain}` 请求，再按 Host 头解析目标 Agent
- **扩展友好**：在不改变 AID 和基础路由规则的前提下，可为 Agent 挂载更多页面和内置服务

## 13.2 泛域名的作用

泛域名解析的主要作用是让 Issuer 统一承接所有 Agent 子域名请求：

```text
*.{issuer_domain}  ->  Agent Web Gateway / 站点入口 / 反向代理
```

请求到达入口服务后，实现者通常按以下步骤处理：

1. 从 HTTP Host 提取目标主机名
2. 将主机名映射到目标 AID 或目标 Agent 资源
3. 根据访问路径、访问方类型和部署策略返回 `agent.md`、`index.html` 或某个内置服务页面

## 13.3 实现建议（非规范性）

以下内容主要是实现建议，不是协议强制要求：

- **DNS**：推荐将 `*.{issuer_domain}` 解析到统一的入口层（CDN、LB、反向代理或 Web Gateway）
- **TLS**：推荐为 `*.{issuer_domain}` 配置泛域名证书，或在入口层统一终止 TLS
- **路由**：推荐由统一入口按 Host 头解析目标 Agent，而不是为每个 Agent 单独配置站点
- **静态资源**：推荐将 `agent.md` 和 `index.html` 视为 Agent 的两个标准 Web 资源
- **访问方识别**：如需区分“Agent 访问”和“人类访问”，推荐基于 User-Agent、Accept 头、显式客户端标识或上层调用约定实现
- **缓存**：推荐对 `agent.md` 使用较短缓存时间，避免 Agent 描述信息长期陈旧；首页可按产品需求设置缓存策略

## 13.4 标准访问路径与默认行为（规范性）

本节定义 Agent Web 访问的**强制行为**。

### 13.4.1 根路径访问

当访问：

```text
https://{aid}.{issuer_domain}
```

服务端必须根据访问方类型返回不同的默认资源：

- **Agent（无头浏览器、程序化客户端、协议消费者）访问时**：
  - **必须**等价于访问：
    ```text
    https://{aid}.{issuer_domain}/agent.md
    ```
  - 返回该 Agent 的 `agent.md` 文档内容

- **人类用户（有头浏览器）访问时**：
  - **必须**等价于访问：
    ```text
    https://{aid}.{issuer_domain}/index.html
    ```
  - 返回该 Agent 的首页内容

这里的 `agent.md` 指 Agent 的标准描述文档，其格式和字段定义已提升到主协议 [08-服务协议](08-服务协议.md) 的 `search.*` 章节统一规定。附录 K 只负责定义 Web 访问入口和默认路径行为，不再重复承载 `agent.md` 结构规范。

### 13.4.2 显式访问 `agent.md`

当显式访问：

```text
https://{aid}.{issuer_domain}/agent.md
```

无论访问方是人还是 Agent，服务端都**必须**返回该 Agent 的 `agent.md` 内容，不得再根据访问方类型改写为其他资源。

### 13.4.3 显式访问 `index.html`

当显式访问：

```text
https://{aid}.{issuer_domain}/index.html
```

无论访问方是人还是 Agent，服务端都**必须**返回该 Agent 的首页内容，不得再根据访问方类型改写为 `agent.md`。

> 说明：协议的规范 URL 为 HTTPS。如部署方额外开放 HTTP 入口，可返回相同内容，或重定向到对应的 HTTPS URL。

### 13.4.4 内置服务页面

当访问：

```text
https://{aid}.{issuer_domain}/{svc}
```

表示访问该 Agent 的某个内置服务页面，其中 `{svc}` 代表系统内置服务标识。

此时：

- 该路径**必须**被解释为“指定 Agent 的指定内置服务页面”
- 页面或资源的具体内容**由实现者决定**
- 如该服务不存在，服务端应返回标准 HTTP 错误（如 `404 Not Found`）

### 13.4.5 路径优先级

服务端处理优先级必须如下：

1. 显式路径优先：`/agent.md`、`/index.html`、`/{svc}` 按显式路径处理
2. 仅当访问根路径 `/` 或无路径时，才根据访问方类型选择默认资源

## 13.5 与 AID 和 Issuer 的关系

该约定意味着：

- 每个 AID 不只是一个通信身份，也是一个标准 Web 可访问对象
- Issuer 不仅负责证书签发和身份管理，也通常负责该 AID 对应 Web 入口的承接
- `agent.md` 是 Agent 面向其他 Agent 的默认公开描述文档，也是 `search.*` 的基础索引对象
- `index.html` 是 Agent 面向人类用户的默认首页

这使 AUN 在保持去中心化身份体系的同时，也为 Agent 的公开发现、说明页、服务页和后续生态扩展提供了统一入口。
