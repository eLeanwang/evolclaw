# Gateway 环境变量配置同步功能

## 功能概述

当用户在 ECWeb 切换到 Gateway 页面时，系统会实时检测 `settings.json` 中引用的环境变量（`$ENV:*`）是否已在进程环境中设置。如果检测到未设置或为空的环境变量引用，会在页面顶部显示红色横幅提醒用户配置不一致，并提供三种同步选项。

## 功能特点

### 1. 实时检测
- 自动扫描 `agents/defaults.json` 和各 `agents/<aid>/config.json` 中的 `baseagents` 配置
- 检测所有 `$ENV:*` 格式的环境变量引用
- 识别未设置或为空的环境变量

### 2. 红色横幅提醒
当检测到配置不一致时，在 Gateway 页面顶部显示醒目的红色横幅，包含：
- ⚠️ 警告图标
- 不一致提示信息
- 检测到的问题数量
- 三个同步按钮 + 一个忽略按钮

### 3. 三种同步选项

#### 选项 1：只同步全局配置
- **操作**：仅同步 `agents/defaults.json` 中引用的环境变量
- **目标**：`{root}/.env` 文件
- **适用场景**：只需要更新全局默认配置

#### 选项 2：同步全局配置 + 全部 Agent 配置
- **操作**：同步全局配置 + 所有 Agent 的环境变量引用
- **目标**：`{root}/.env` + 所有 `agents/<aid>/.env` 文件
- **适用场景**：全面同步所有配置

#### 选项 3：同步全局配置 + 指定 Agent 配置
- **操作**：弹出 Agent 选择框，用户可多选需要同步的 Agent
- **目标**：`{root}/.env` + 选中的 `agents/<aid>/.env` 文件
- **适用场景**：精确控制需要同步的 Agent

### 4. 同步行为
- **保留现有内容**：不会删除 `.env` 文件中的其他变量
- **更新匹配变量**：如果环境变量已在 `.env` 中存在，更新为当前进程环境的值
- **追加新变量**：如果环境变量不在 `.env` 中，追加到文件末尾
- **来源优先级**：从当前进程环境变量（`process.env`）读取值

## 技术实现

### 后端 API

#### 1. 检测接口
- **位置**：`src/core/message/command-handler-gateway-control.ts`
- **函数**：`detectEnvMismatch()`
- **返回**：
  ```typescript
  {
    hasMismatch: boolean;
    mismatches: Array<{
      aid: string;      // 'defaults' 或 agent AID
      type: string;     // 'claude' / 'codex' / 'gemini'
      field: string;    // 配置字段名（如 'apiKey'）
      envValue: string; // 当前环境变量值（或 "(未设置)"）
      configValue: string; // 配置中的引用（如 "$ENV:ANTHROPIC_API_KEY"）
    }>;
  }
  ```

#### 2. 同步接口
- **路由**：`menu.action` → `name: 'gateway'` → `action: 'sync-env'`
- **函数**：`gatewaySyncEnv()`
- **参数**：
  ```typescript
  {
    syncType: 'global' | 'all-agents' | 'specific-agents';
    targetAids?: string[]; // 仅 specific-agents 模式需要
  }
  ```
- **返回**：
  ```typescript
  {
    synced: string[];  // 已同步的配置文件列表
    count: number;     // 同步文件数量
  }
  ```

### 前端实现

#### 1. 横幅渲染
- **位置**：`ecweb/src/static/app.js` → `renderGateway()`
- **触发**：切换到 Gateway 视图时自动检测
- **样式**：`ecweb/src/static/style.css` → `.gw-env-mismatch-banner`

#### 2. 事件绑定
- **位置**：`ecweb/src/static/app.js` → `bindGatewayEvents()`
- **功能**：
  - 同步全局配置按钮
  - 同步全部 Agent 按钮
  - 同步指定 Agent 按钮（弹出选择框）
  - 忽略横幅按钮

#### 3. Agent 选择框
- **函数**：`openAgentSelectModal()`
- **特点**：
  - 复选框多选
  - 显示 Agent 短名和完整 AID
  - 确认后调用同步 API

## 使用流程

1. 用户切换到 ECWeb 的 Gateway 页面
2. 系统自动检测环境变量配置
3. 如果检测到不一致，显示红色横幅
4. 用户选择三种同步选项之一：
   - 点击"同步全局配置"：直接同步
   - 点击"同步全局+全部Agent"：直接同步所有
   - 点击"同步指定Agent"：弹出选择框，勾选后点击"同步选中的 Agent"
5. 系统执行同步操作，更新相应的 `.env` 文件
6. 显示成功提示，刷新 Gateway 视图
7. 横幅消失（配置已一致）

## 安全考虑

1. **权限控制**：
   - 仅控制 channel 可访问 gateway 操作
   - 需要 owner 权限才能执行同步

2. **数据安全**：
   - API Key 等敏感信息始终保持 `$ENV:*` 引用格式
   - 不会在网络传输或日志中暴露明文密钥
   - 环境变量值从进程内存读取，不经过客户端

3. **文件安全**：
   - 使用原子写入（通过 `fs.writeFileSync`）
   - 保留文件原有内容和注释
   - 仅更新匹配的环境变量

## 测试要点

1. **检测功能**：
   - 配置中包含 `$ENV:UNSET_VAR` 应触发横幅
   - 所有环境变量已设置应无横幅
   - 多个不一致应显示正确数量

2. **同步功能**：
   - 全局同步应创建/更新 `.env`
   - Agent 同步应创建/更新 `agents/<aid>/.env`
   - 已存在的变量应被更新
   - 不相关的变量应被保留

3. **UI 交互**：
   - 横幅在同步后应消失
   - 忽略按钮应隐藏横幅
   - Agent 选择框应支持多选
   - 按钮状态（禁用/加载中）应正确

## 文件清单

### 后端
- `src/core/message/command-handler-gateway-control.ts` - 检测和同步逻辑
- `src/core/command/menu-handler.ts` - 路由注册

### 前端
- `ecweb/src/static/app.js` - UI 渲染和事件处理
- `ecweb/src/static/style.css` - 横幅和模态框样式

## 未来增强

1. **更智能的检测**：
   - 检测 `.env` 文件中的变量是否与配置引用匹配
   - 提示重复或未使用的环境变量

2. **批量操作**：
   - 一键清理未使用的环境变量引用
   - 批量转换明文密钥为环境变量引用

3. **版本控制集成**：
   - 自动添加 `.env` 到 `.gitignore`
   - 生成 `.env.template` 示例文件

4. **详细报告**：
   - 显示每个不一致的详细信息
   - 提供手动编辑环境变量的快捷入口
