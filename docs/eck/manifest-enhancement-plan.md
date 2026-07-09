# Manifest 增强实施计划

> 时间:2026-07-09  
> 状态:✅ 机制2 + 机制3 已实施完成（编译零错误 + 冒烟验证通过）
> 范围:机制2(目录+总量保护) + 机制3(多会话类型 → 独立 manifest)

---

## 一、背景与目标

### 当前问题

1. **目录加载无保护**:`type: directory` 段无文件数/字节上限,失控目录会撑爆提示词
2. **单一 manifest 文件**:所有会话类型(主/辅助/审批/目标管理...)共用 `eck_manifest.json`,无法按会话原型定制系统提示词
3. **路径浪费 token**(本轮不做,留批3):每段前缀带完整路径(`Contenu de ...`)

### 目标

- **机制2**:双层限额保护 + 截断说明(单目录 20个/40KB + 总闸 50个/100KB)
- **机制3**:引入 `sessionType` 维度,每类会话加载独立 manifest,复用同一引擎、同一两级覆盖机制

---

## 二、技术方案

### 机制2:双层限额保护

#### 限额规格

| 层级 | 维度 | 默认值 | 可覆盖字段 |
|------|------|--------|-----------|
| **单目录段** | 文件数 | 20 | section.maxFiles |
| **单目录段** | 字节数 | 40KB (40960) | section.maxBytes |
| **整个清单** | 文件数 | 50 | manifest顶层.totalMaxFiles |
| **整个清单** | 字节数 | 100KB (102400) | manifest顶层.totalMaxBytes |

**现状核实**:当前唯一 directory 段 `$KITS_RULES` = 6文件/17.9KB,安全不触限。

#### 超限行为

1. **单目录超限**:
   - 停止加载后续文件
   - 该段末尾注入:`[目录 <path> 未完整加载:N 个文件超限(达M限)]`
   - 写入 diagnostics(debug)

2. **总闸超限**:
   - 停止加载后续所有段
   - 末尾注入:`[清单总量超限(>50文件/>100KB),以下 section 未加载:<id1>, <id2>, ...]`
   - 写入 diagnostics

---

### 机制3:多会话类型 → 独立 manifest

#### sessionType 维度

在 Session 接口加可选字段:
```typescript
export interface Session {
  ...
  sessionType?: string;  // 'main'|'auxiliary'|'approval'|...,默认 'main'
  ...
}
```

#### config 映射字段

照搬 `render` 的成熟模式,在 agent config 加:
```jsonc
{
  "sessionManifests": {
    "main": "eck_manifest.json",           // 缺省可省略
    "auxiliary": "eck_manifest.auxiliary.json",
    "approval": "eck_manifest.approval.json"
  }
}
```

- 走 config 现有分级覆盖(关系/环境/agent)
- 加入 `behaviorFieldNames` 可覆盖白名单

#### 调用链

```
sessionManager 创建 session(带 sessionType)
→ response-engine 读 session.sessionType ?? 'main'
→ 查 config.sessionManifests[sessionType] ?? 'eck_manifest.json'
→ renderKitSections(ctx, manifestFile)
→ loadManifest(manifestFile)  ← 引擎已支持任意文件名,走两级 patch 合并
```

**两级覆盖天然满足**:每个 manifest 文件各自走 `$KITS/` + `$EVOLCLAW_HOME/eck/` 两级合并。

---

## 三、改动清单

### 代码(5个文件)

| 文件 | 机制 | 改动点 | 行号参考 |
|------|------|--------|----------|
| `src/types.ts` | 3 | Session 接口加 `sessionType?: string` | 218-238 |
| `src/eck/manifest-engine.ts` | 2 | ① ManifestSection 加 maxFiles/maxBytes<br>② RawManifest 加 totalMaxFiles/totalMaxBytes<br>③ readDirectoryFiles 实现单目录限额+overflow 返回 | 16(interface)<br>49(RawManifest)<br>334(readDirectoryFiles) |
| `src/eck/kit-renderer.ts` | 2+3 | ① renderKitSections 加 manifestFile 参数<br>② 全局总量计数器(usedFiles/usedBytes)<br>③ 单目录 overflow → 注入截断说明<br>④ 总闸超限 → 停止循环,收集未加载 section id,注入总截断说明<br>⑤ 两种都写 diagnostics | 11(MANIFEST_FILE)<br>66(renderKitSections)<br>73-124(段循环) |
| `src/config/config-manager.ts` | 3 | ① assembleEffectiveConfig 加 sessionManifests 到 effective<br>② behaviorFieldNames 白名单加 'sessionManifests' | 543(effective整合)<br>571(白名单) |
| `src/core/message/response-engine.ts` | 3 | ① 读 session.sessionType ?? 'main'<br>② 查 config.sessionManifests[sessionType] ?? 'eck_manifest.json'<br>③ 传 manifestFile 给 renderKitSections | 1371-1377(调用点) |

---

### 配置文件(1个新建)

| 文件 | 内容 |
|------|------|
| `kits/eck_manifest.auxiliary.json` | 辅助会话基础 manifest(职责/规则/背压 fragment),order/when/needsInjection 等复用现有 schema |

**辅助会话 manifest 内容设计**(基于 dual-session 文档):
- rules:复用 `$KITS_RULES`(ECK 核心规则,所有会话共享)
- auxiliary-role:辅助会话职责 fragment(判断相关性/分段输入/背压调节)
- 不加载:身份层/关系层/对端 profile/venue(辅助会话不需要这些重段)

---

### 文档(4个)

| 文件 | 改动 |
|------|------|
| `kits/docs/context-assembly.md` | ① section 字段表加 maxFiles/maxBytes/说明<br>② manifest 顶层字段加 totalMaxFiles/totalMaxBytes<br>③ 新增"多 manifest(sessionType 维度)"节<br>④ 截断说明机制<br>⑤ 覆盖机制说明补"每个 manifest 文件各自两级合并" |
| `kits/docs/prompt-loading-architecture.md` | ① manifestFile 维度说明<br>② 目录+总量限额说明<br>③ 输出结构加截断说明示例 |
| `docs/response-system/dual-session/eck-integration.md` | 辅助会话改为"独立 manifest `eck_manifest.auxiliary.json`"(原设计是往主 manifest 塞段) |
| `docs/response-system/dual-session/auxiliary-base.md` | 补"参考量级"段(背压信号的定性指引,已确定要加) |

---

## 四、实施顺序

### 阶段1:机制2(目录+总量保护) — 优先,纯加固,不依赖其他

**代码改动**:
1. `src/eck/manifest-engine.ts`:
   - ManifestSection 加 `maxFiles?: number; maxBytes?: number;`
   - RawManifest 加 `totalMaxFiles?: number; totalMaxBytes?: number;`
   - `readDirectoryFiles` 实现单目录限额,返回 `{ files, overflow? }`
2. `src/eck/kit-renderer.ts`:
   - 全局计数器 `usedFiles` / `usedBytes`
   - 段循环里检查总闸,超限则停止并收集剩余 section id
   - 单目录 overflow → 注入截断行
   - 总闸超限 → 注入总截断行(含未加载 id 集合)
   - diagnostics 记录两种截断

**文档同步**:
- `kits/docs/context-assembly.md`:section 字段 + manifest 顶层字段 + 截断机制
- `kits/docs/prompt-loading-architecture.md`:限额说明

**测试点**:
- 目录 >20 文件 / >40KB → 截断正确 + 说明注入
- 全清单 >50 文件 / >100KB → 停止加载 + 未加载 section id 集合正确
- 现有 `$KITS_RULES`(6文件/17.9KB)不触限

---

### 阶段2:机制3(sessionType → 独立 manifest)

**代码改动**:
1. `src/types.ts`:Session 加 `sessionType?: string`
2. `src/config/config-manager.ts`:
   - effective 整合加 `sessionManifests: config.sessionManifests`
   - behaviorFieldNames 白名单加 `'sessionManifests'`
3. `src/eck/kit-renderer.ts`:
   - `renderKitSections(ctx, manifestFile = 'eck_manifest.json')`
4. `src/core/message/response-engine.ts`:
   ```typescript
   const sessionType = session.sessionType ?? 'main';
   const manifestFile = agentConfig.sessionManifests?.[sessionType] ?? 'eck_manifest.json';
   const kitContext = renderKitSections(kitCtx, manifestFile);
   ```

**配置文件**:
- 新建 `kits/eck_manifest.auxiliary.json`(辅助会话 manifest)

**文档同步**:
- `kits/docs/context-assembly.md`:多 manifest 机制 + sessionType 维度
- `kits/docs/prompt-loading-architecture.md`:manifestFile 参数
- `docs/response-system/dual-session/eck-integration.md`:辅助会话独立 manifest
- `docs/response-system/dual-session/auxiliary-base.md`:加"参考量级"段

**测试点**:
- session.sessionType 缺省 → 加载 `eck_manifest.json`(兼容现有行为)
- `sessionType: 'auxiliary'` + config.sessionManifests.auxiliary → 加载辅助 manifest
- 两级覆盖:`$KITS/eck_manifest.auxiliary.json` + `$ECK/eck_manifest.auxiliary.json` 正确合并

---

## 五、风险与依赖

### 风险

| 风险 | 级别 | 缓解措施 |
|------|------|---------|
| 默认限额 20/40KB 过严,误伤合理用例 | 低 | ① 现状 rules 6文件/17.9KB 安全<br>② section 可覆盖 maxFiles/maxBytes<br>③ 文档说明调整方法 |
| 总闸 50/100KB 拦截大型定制 manifest | 中 | ① manifest 顶层可覆盖 totalMax*<br>② 文档提示优化:删冗余段、拆大文件 |
| sessionType 未传时兜底 'main' 可能掩盖 bug | 低 | ① 文档明确"缺省=main"语义<br>② dual-session 引擎必须显式传 'auxiliary' |
| config.sessionManifests 为空时回退逻辑 | 低 | 代码用 `?? 'eck_manifest.json'` 三重兜底 |

### 依赖

- **机制2 → 无依赖**,可独立落地
- **机制3 → 依赖机制2 的文档/测试完成**,确保 manifest 引擎稳定后再加 manifestFile 参数化

---

## 六、验收标准

### 机制2

- [ ] 单目录段超 20 文件 / 40KB 时停止加载,末尾注入截断说明,diagnostics 有记录
- [ ] 全清单超 50 文件 / 100KB 时停止,末尾注入总截断说明(含未加载 section id 列表)
- [ ] 现有 `$KITS_RULES` 目录(6文件/17.9KB)完整加载,无截断
- [ ] section 可覆盖 maxFiles/maxBytes,manifest 顶层可覆盖 totalMax*
- [ ] 文档完整描述限额机制、截断格式、调整方法

### 机制3

- [ ] Session.sessionType 缺省时,加载 `eck_manifest.json`(现有行为不变)
- [ ] sessionType='auxiliary' + config.sessionManifests.auxiliary 时,加载辅助 manifest
- [ ] 两级覆盖正确:`$KITS/eck_manifest.auxiliary.json` + `$ECK/eck_manifest.auxiliary.json` patch 合并
- [ ] config.sessionManifests 走分级覆盖(关系/环境/agent)
- [ ] `kits/eck_manifest.auxiliary.json` 内容合理(rules + auxiliary-role,不含身份/关系/venue 重段)
- [ ] 文档完整描述 sessionType 维度、sessionManifests 配置、两级覆盖机制

---

## 七、后续批次(本轮不做)

### 批3:嵌套+循环 + 路径别名省 token

- **嵌套+循环**:section 支持 `wrapper`/`forEach`/`children`,用于批量消息包裹层
- **路径别名**:输出前缀用短别名(已有 `shortenPath` 原语)或只输出 section id,不输出完整路径

**依赖**:批3 的 schema 扩展(wrapper/forEach)需要和本轮的 maxFiles/sessionManifests 统一设计,避免字段冲突。

---

## 八、开工检查清单

- [x] 核实 `$KITS_RULES` 体量(6文件/17.9KB),确认默认限额安全
- [x] 核实 manifest-engine.ts 代码结构(loadManifest 已支持任意文件名)
- [x] 核实 kit-renderer.ts 调用点(renderKitSections 第66行)
- [x] 核实 config-manager.ts render 字段先例(543行 effective + 571行白名单)
- [x] 核实 response-engine.ts 调用点(1377行 renderKitSections)
- [x] 核实 Session 接口无 sessionType 字段(需新增)
- [x] 用户确认:sessionType 字段名、限额数值(20/40KB + 50/100KB)、总闸超限带未加载 section id 集合
- [x] 用户同意给 Session 加 sessionType 字段

**状态:✅ 全部就绪,可以开工**

---

**预计工作量**:
- 机制2:代码 2-3 小时 + 文档 1 小时 + 测试 1 小时 = **4-5 小时**
- 机制3:代码 1-2 小时 + 配置文件 0.5 小时 + 文档 1 小时 + 测试 0.5 小时 = **3-4 小时**
- **总计:7-9 小时**(按顺序分两阶段)

**开工时间**:2025-01-19(现在)

---

## 九、机制4:嵌套+循环(三段式 wrapper+forEach+child)— ✅ 已完成

### 目标

给 manifest 引擎加三段式循环能力：wrapper（包裹层）+ forEach（循环数据源）+ child（子模板），
供响应模式（单会话/双会话）批量处理消息——把背压信号、批次头尾渲染在逐条消息外层。

### Schema

section 加可选 `loop`：
```jsonc
"loop": { "forEach": "items", "childFile": "$KITS_.../item.md", "separator": "\n" }
```
有 loop 时 file 作 wrapper（含 `{{@loop}}` 占位）。separator 默认 `\n`。

### 实现要点

- **复用现有 `{{#each}}` 原语**（已验证嵌套/对象数组/`@index`/空数组落空）
- **wrapper 与循环结果分离渲染**：wrapper 渲染批次 vars，`{{@loop}}` 用哨兵占位后字面量填入循环结果 → 循环结果不被二次解析
- **系统层(kit-renderer)**：loop 数据可信（背压信号），`renderSectionContent` 检测 section.loop → renderLoopSection
- **消息层(message-renderer)**：child = renderOneItem 逐条结果（自带 content 哨兵），wrapBatch 只字面量拼接 → 用户消息 `{{}}` 不被解析；无 loop 段回退现有 join（向后兼容）

### 改动清单

| 文件 | 改动 |
|------|------|
| `src/eck/manifest-engine.ts` | LoopSpec 类型；ManifestSection 加 loop；renderLoopSection（含 onElementScope 钩子、separator）；loadChildTemplate |
| `src/eck/kit-renderer.ts` | 导入 renderLoopSection/loadChildTemplate；renderSectionContent 处理 loop |
| `src/eck/message-renderer.ts` | renderOneItem 跳过 loop 段；renderMessageBody 加 wrapBatch 批次包裹 |
| `kits/docs/context-assembly.md` | loop 字段 + 三段式循环章节 |
| `kits/docs/prompt-loading-architecture.md` | 批次包裹层（loop 段）说明 |

### 验收(冒烟通过)

- [x] 系统层：wrapper 批次 vars + 循环 + 分隔符(换行/空行/无)+ 空数组落空
- [x] 消息层：批次包裹 + **哨兵生效**（用户消息 `{{name}}` 原样保留）
- [x] 向后兼容：无 loop 段时逐条渲染行为不变
- [x] 全套编译零错误

### 消费方

单会话响应模式（防抖聚合的多条消息批量渲染）、双会话响应模式（辅助会话背压包裹 + 主会话批量）——
均是待实现的响应模式引擎，本机制为其提供基础设施。

---

**开工日期修正**:实际实施 2026-07-09。机制2/3/4 已全部落地，编译零错误 + 冒烟验证通过。
