# Skill插件系统设计（修订版）— 设备端插件机制

> 状态：draft v0.3
> 创建：2026-05-19
> 修订原因：v0.2 忽略了移动端App不能直接执行任意JS的现实约束

## 核心问题

手机App（iOS/Android）是编译好的沙箱环境：
- 不能像Node.js那样 `require('./handler.js')` 加载任意代码
- iOS审核不允许动态下载可执行代码（除了JS in WebView/JSCore）
- 需要一个**App内的插件运行时**来承载第三方skill

## 修正后的架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         AUN Network                              │
│                                                                  │
│   skill.invoke 消息从 agent 发到 Alice 的手机                     │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Evol App（手机端）                              │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ AUN SDK（收发消息）                                         │  │
│  │ 收到 skill.invoke → 路由到 Plugin Runtime                   │  │
│  └───────────────────────────────┬────────────────────────────┘  │
│                                  │                                │
│  ┌───────────────────────────────▼────────────────────────────┐  │
│  │              Plugin Runtime（插件运行时）                     │  │
│  │                                                             │  │
│  │  ┌─────────────────────────────────────────────────────┐   │  │
│  │  │ JS Sandbox（JavaScriptCore / Hermes / QuickJS）      │   │  │
│  │  │                                                      │   │  │
│  │  │  第三方插件代码在这里执行                               │   │  │
│  │  │  只能通过 bridge 对象访问原生能力                       │   │  │
│  │  │                                                      │   │  │
│  │  │  bridge.camera.capture()                             │   │  │
│  │  │  bridge.gps.location()                               │   │  │
│  │  │  bridge.audio.record()                               │   │  │
│  │  │  bridge.http.fetch()                                 │   │  │
│  │  │  bridge.storage.get/set()                            │   │  │
│  │  └──────────────────────────┬───────────────────────────┘   │  │
│  │                             │ bridge调用                     │  │
│  │  ┌──────────────────────────▼───────────────────────────┐   │  │
│  │  │ Native Bridge（原生桥）                               │   │  │
│  │  │                                                      │   │  │
│  │  │ bridge.camera → 调用系统相机API                       │   │  │
│  │  │ bridge.gps → 调用CoreLocation/LocationManager        │   │  │
│  │  │ bridge.audio → 调用AVFoundation/MediaRecorder        │   │  │
│  │  │ bridge.http → 调用URLSession/OkHttp                  │   │  │
│  │  │ bridge.storage → 调用本地KV存储                       │   │  │
│  │  │                                                      │   │  │
│  │  │ 每个bridge方法都经过权限检查 + confirm弹窗            │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ Plugin Store（本地插件仓库）                                  │  │
│  │                                                              │  │
│  │ plugins/                                                     │  │
│  │ ├── camera-ocr/                                              │  │
│  │ │   ├── manifest.json    ← 声明                              │  │
│  │ │   └── main.js          ← 插件代码（在JS Sandbox中执行）    │  │
│  │ ├── ambient-sound/                                           │  │
│  │ │   ├── manifest.json                                        │  │
│  │ │   └── main.js                                              │  │
│  │ └── ...                                                      │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## 为什么是JS Sandbox

| 方案 | 可行性 | 说明 |
|---|---|---|
| 直接加载原生代码 | ❌ | iOS禁止、安全风险极高 |
| WebView | ⚠️ | 可以但性能差、UI受限 |
| **嵌入式JS引擎** | ✅ | JavaScriptCore(iOS自带)/Hermes/QuickJS，无审核风险 |
| WASM | ⚠️ | 可以但生态不成熟、调试困难 |
| Lua | ⚠️ | 可以但开发者少 |

**选择嵌入式JS引擎**的原因：
- iOS自带JavaScriptCore，无需额外依赖
- Android可用Hermes（React Native引擎）或QuickJS
- JS开发者最多，黑客松参与门槛最低
- 微信小程序已验证这条路可行

## 插件格式

### manifest.json（声明文件）

```jsonc
{
  "id": "camera-ocr",
  "version": "1.0.0",
  "name": "拍照OCR",
  "description": "拍照识别文字",
  "author": "developer@example.com",

  // 需要哪些bridge能力
  "permissions": [
    "camera",           // bridge.camera.*
    "http"              // bridge.http.fetch（调外部OCR API）
  ],

  // 入口文件
  "main": "main.js",

  // 调用参数schema
  "params": {
    "language": { "type": "string", "default": "zh", "enum": ["zh", "en", "ja"] }
  },

  // 返回值schema
  "returns": {
    "text": { "type": "string" },
    "confidence": { "type": "number" }
  },

  // 调用约束
  "timeout_ms": 30000,
  "confirm_level": "L1",

  // 适用平台
  "platforms": ["ios", "android"]
}
```

### main.js（插件代码）

```javascript
// main.js — 在App的JS Sandbox中执行
// 全局只有一个 bridge 对象可用，没有 require/import/fetch/fs 等

async function execute(params) {
  // 1. 通过bridge调用原生相机
  const photo = await bridge.camera.capture({ facing: 'back' });

  // 2. 通过bridge发HTTP请求（调外部OCR API）
  const response = await bridge.http.fetch('https://api.ocr.com/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: photo.data
  });

  const result = JSON.parse(response.body);

  // 3. 返回结果
  return {
    text: result.text,
    confidence: result.confidence
  };
}

// 导出入口函数（Plugin Runtime会调用这个）
exports.execute = execute;
```

**插件代码的约束**：
- 没有 `require` / `import`（不能加载其他模块）
- 没有 `fetch` / `XMLHttpRequest`（只能通过 `bridge.http.fetch`）
- 没有文件系统访问（只能通过 `bridge.storage`）
- 没有 `eval` / `Function()`（禁止动态代码生成）
- 只有 `bridge` 对象 + 标准JS内置对象（Array/Object/Promise/JSON等）

## Bridge API（App暴露给插件的原生能力）

### bridge.camera

```javascript
bridge.camera.capture({ facing, flash })        → { data, width, height, format }
bridge.camera.record({ duration, facing })      → { data, duration, format }
bridge.camera.scanQR()                          → { content, format }
```

### bridge.audio

```javascript
bridge.audio.record({ duration, sampleRate })   → { data, duration, format }
bridge.audio.play({ data, format })             → { played: true }
```

### bridge.gps

```javascript
bridge.gps.location()                           → { city, district, street, placeType }
// 注意：只返回语义位置，不返回精确坐标
```

### bridge.sensor

```javascript
bridge.sensor.battery()                         → { level, charging }
bridge.sensor.network()                         → { type, ssid }
bridge.sensor.motion()                          → { activity }  // still/walking/driving
bridge.sensor.light()                           → { lux }
bridge.sensor.pressure()                        → { hPa }
```

### bridge.contacts

```javascript
bridge.contacts.search({ name })                → [{ name, company, email }]
// 注意：永远不返回手机号
```

### bridge.http

```javascript
bridge.http.fetch(url, { method, headers, body })  → { status, headers, body }
// 受限：不能访问内网IP、有频率限制
```

### bridge.storage

```javascript
bridge.storage.get(key)                         → value
bridge.storage.set(key, value)                  → void
bridge.storage.delete(key)                      → void
bridge.storage.keys()                           → [keys]
// 每个插件独立存储空间，互不可见
```

### bridge.ui

```javascript
bridge.ui.toast(message)                        → void
bridge.ui.alert(title, message, buttons)        → { clicked }
bridge.ui.progress(percent, message)            → void
// 插件可以在App内显示简单UI反馈
```

### bridge.clipboard

```javascript
bridge.clipboard.read()                         → { text }
bridge.clipboard.write(text)                    → void
```

### bridge.flashlight

```javascript
bridge.flashlight.on()                          → void
bridge.flashlight.off()                         → void
bridge.flashlight.blink(pattern)                → void  // [100,200,100] = 亮100ms暗200ms亮100ms
```

### bridge.haptic

```javascript
bridge.haptic.vibrate(pattern)                  → void  // light/medium/heavy/[ms,ms,ms]
```

### bridge.notification

```javascript
bridge.notification.schedule({ title, body, delay_ms })  → { id }
bridge.notification.cancel(id)                           → void
```

## 完整调用流程（修正版）

```
Agent（evolclaw）                    AUN Network                    Evol App（手机）
      │                                  │                              │
      │ 用户说"识别桌上名片"              │                              │
      │                                  │                              │
      │ 查 venue skills.json             │                              │
      │ 找到 alice 提供 camera-ocr       │                              │
      │                                  │                              │
      ├─── skill.invoke ────────────────►│─────────────────────────────►│
      │    {skill:"camera-ocr",          │                              │
      │     args:{language:"zh"}}        │                              │
      │                                  │                              │
      │                                  │                    ┌─────────┤
      │                                  │                    │ AUN SDK │
      │                                  │                    │ 收到消息 │
      │                                  │                    └────┬────┤
      │                                  │                         │    │
      │                                  │                         ▼    │
      │                                  │              ┌──────────────┐│
      │                                  │              │Plugin Runtime││
      │                                  │              │              ││
      │                                  │              │ 1.查manifest ││
      │                                  │              │   camera-ocr ││
      │                                  │              │              ││
      │                                  │              │ 2.confirm_L1 ││
      │                                  │              │   弹toast    ││
      │                                  │              │   用户未取消  ││
      │                                  │              │              ││
      │                                  │              │ 3.启动JS引擎 ││
      │                                  │              │   加载main.js││
      │                                  │              │   调execute()││
      │                                  │              │              ││
      │                                  │              │ 4.插件调用    ││
      │                                  │              │   bridge.    ││
      │                                  │              │   camera.    ││
      │                                  │              │   capture()  ││
      │                                  │              │      │       ││
      │                                  │              │      ▼       ││
      │                                  │              │ Native Bridge││
      │                                  │              │ 权限检查通过  ││
      │                                  │              │ 调系统相机API ││
      │                                  │              │ 用户拍照      ││
      │                                  │              │ 返回图片数据  ││
      │                                  │              │      │       ││
      │                                  │              │      ▼       ││
      │                                  │              │ 5.插件继续    ││
      │                                  │              │   bridge.    ││
      │                                  │              │   http.fetch ││
      │                                  │              │   调OCR API  ││
      │                                  │              │   得到文字    ││
      │                                  │              │              ││
      │                                  │              │ 6.返回结果    ││
      │                                  │              │   {text,conf}││
      │                                  │              └──────┬───────┘│
      │                                  │                     │        │
      │                                  │◄────────────────────┤        │
      │◄─── skill.result ───────────────│         skill.result         │
      │    {text:"张三\n...",            │                              │
      │     confidence:0.95}             │                              │
      │                                  │                              │
      │ 回复用户："名片内容是..."         │                              │
      │                                  │                              │
```

## 插件安装流程

### 用户视角

```
1. 用户在App内打开"插件市场"
2. 浏览/搜索插件（如"OCR"）
3. 点击"安装"
4. App显示权限清单：
   "该插件需要：📷 相机、🌐 网络访问"
   [安装] [取消]
5. 用户确认 → 下载 manifest.json + main.js 到本地
6. 插件出现在"已安装"列表
7. 下次agent调用时自动可用
```

### 技术流程

```
App从插件市场下载插件包
    │
    ├─ 1. 下载 manifest.json + main.js（可能还有资源文件）
    │
    ├─ 2. 校验 manifest.json
    │      - 字段完整性
    │      - permissions 是否在App支持的bridge范围内
    │      - main.js 静态扫描（禁止eval/Function等）
    │
    ├─ 3. 存储到本地
    │      App沙箱/plugins/camera-ocr/
    │      ├── manifest.json
    │      └── main.js
    │
    ├─ 4. 注册到本地插件清单
    │      plugins/_registry.json 新增条目
    │
    └─ 5. 通过AUN广播 skill.register
         告知所有venue："我现在有camera-ocr能力了"
```

### 插件来源

| 来源 | 说明 | 安全级别 |
|---|---|---|
| 官方插件市场 | 审核过的插件 | 高（已审核） |
| URL直装 | 开发者分享链接 | 中（用户自担风险） |
| 本地开发 | 开发者调试用 | 低（仅开发模式） |

## 桌面端 vs 服务端的差异

| 端 | 插件运行方式 | 说明 |
|---|---|---|
| **手机App** | 嵌入式JS引擎（JSCore/Hermes） | 插件是 main.js，通过bridge调原生 |
| **桌面App** | 嵌入式JS引擎 或 Node.js子进程 | 桌面限制少，可以给更多能力 |
| **服务端（evolclaw）** | Node.js直接require | handler.js直接跑，能力最强 |
| **IoT设备** | 通常不支持第三方插件 | 只暴露固定的原生能力 |

**统一点**：无论哪个端，对外暴露的AUN协议一样（skill.register/invoke/result），调用者不需要知道对方是手机还是服务器。

## 安全模型（修正版）

### 插件沙箱边界

```
┌─────────────────────────────────────────────┐
│ JS Sandbox                                   │
│                                              │
│  插件代码能做的：                              │
│  ✅ 调用 bridge.* 方法                        │
│  ✅ 标准JS运算（字符串处理、JSON解析等）        │
│  ✅ Promise/async-await                       │
│  ✅ setTimeout/setInterval（有上限）           │
│                                              │
│  插件代码不能做的：                            │
│  ❌ require/import 任何模块                    │
│  ❌ 访问文件系统（除了bridge.storage）          │
│  ❌ 直接发网络请求（除了bridge.http.fetch）     │
│  ❌ eval / new Function()                     │
│  ❌ 访问其他插件的数据                         │
│  ❌ 访问App的其他数据（通讯录原始数据等）       │
│  ❌ 修改bridge对象本身                         │
│                                              │
└─────────────────────────────────────────────┘
```

### bridge方法的权限控制

```
插件调用 bridge.camera.capture()
    │
    ├─ 1. Plugin Runtime检查：manifest.json的permissions包含"camera"？
    │      ❌ 不包含 → 抛出 PermissionError，插件收到异常
    │      ✅ 包含 → 继续
    │
    ├─ 2. 检查系统权限：App有相机权限？
    │      ❌ 没有 → 弹出系统授权弹窗
    │      ✅ 有 → 继续
    │
    ├─ 3. 检查confirm_level：
    │      L0 → 静默执行
    │      L1 → toast提示（"camera-ocr正在使用相机"）
    │      L2 → 弹窗确认（"允许camera-ocr拍照？"）
    │
    └─ 4. 执行原生调用，返回结果给插件
```

### bridge.http.fetch的限制

```javascript
// 插件调用
const resp = await bridge.http.fetch(url, options);

// Native Bridge内部检查：
// 1. url不能是内网IP（10.*/172.16-31.*/192.168.*）→ 防SSRF
// 2. 频率限制：每分钟最多20次请求
// 3. 响应体大小限制：最大10MB
// 4. 超时：单次请求最多30秒
// 5. 不能访问 localhost / 127.0.0.1
```

## 开发者工作流（黑客松场景）

### 开发环境

```
1. 开发者在电脑上写 manifest.json + main.js
2. 用 evolclaw 提供的CLI工具验证：
   $ evolclaw skill validate ./camera-ocr
   ✅ manifest.json 格式正确
   ✅ main.js 无禁止语法
   ✅ permissions: [camera, http] 合法

3. 本地模拟测试（不需要真机）：
   $ evolclaw skill test ./camera-ocr --mock
   模拟 bridge.camera.capture → 返回测试图片
   模拟 bridge.http.fetch → 返回mock响应
   输出：{ text: "mock text", confidence: 0.9 }

4. 真机测试：
   - 把插件目录打包成 .zip
   - 手机App扫码安装（开发模式）
   - 或通过 evolclaw skill push ./camera-ocr --device=iphone
     （通过AUN网络推送到手机App）
```

### 发布到插件市场

```
$ evolclaw skill publish ./camera-ocr
  → 打包 manifest.json + main.js
  → 上传到插件市场 CDN
  → 提交审核（自动扫描 + 人工审核）
  → 审核通过后上架
```

## 与群Skill架构的关系

```
群Skill架构（docs/group-skill-architecture.md）
    定义了：venue skill registry、调用协议、授权机制
    回答：谁能调用谁的什么能力

本文档（Skill Plugin System）
    定义了：设备端怎么承载第三方skill
    回答：一个能力在设备上具体怎么执行

两者的接口是 AUN 消息协议：
    skill.register — 告诉venue我有什么能力
    skill.invoke — 请求执行
    skill.result — 返回结果

无论skill是App内置的、还是第三方插件提供的，
对外暴露的AUN协议完全一样，调用者无感知。
```

## 实现优先级（黑客松前）

| 优先级 | 组件 | 在哪实现 | 工作量 |
|---|---|---|---|
| P0 | JS Sandbox + bridge基础（camera/http/storage） | 手机App | 大 |
| P0 | manifest.json schema + 校验 | evolclaw CLI | 小 |
| P0 | 插件本地安装 + _registry.json | 手机App | 中 |
| P0 | skill.register/invoke/result 协议 | evolclaw核心 | 中 |
| P0 | `evolclaw skill validate/test --mock` | evolclaw CLI | 中 |
| P1 | 插件市场（上传/下载/搜索） | 后端服务 | 大 |
| P1 | 更多bridge API（audio/sensor/contacts） | 手机App | 中 |
| P1 | 桌面端Plugin Runtime | 桌面App | 中 |
| P2 | 审核系统 | 后端服务 | 大 |
| P2 | 计费/统计 | 后端服务 | 大 |

## 开放问题

1. **JS引擎选择**：iOS用自带的JavaScriptCore没问题，Android用什么？Hermes（Meta开源，轻量）还是QuickJS（更小更快）？

2. **插件包大小限制**：main.js最大多少？建议：单文件500KB上限（压缩后），含资源文件总计2MB上限。

3. **插件间通信**：插件A能否调用插件B？建议：Phase 1不支持，Phase 2通过 `bridge.skill.invoke('other-plugin', params)` 支持。

4. **插件UI**：插件能否渲染自定义UI（不只是toast/alert）？建议：Phase 1只支持bridge.ui的简单UI，Phase 2考虑支持插件渲染WebView页面。

5. **热更新**：插件更新后是否需要重启App？建议：不需要，Plugin Runtime下次加载时自动用新版本。
