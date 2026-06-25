# 前端能力层设计（Frontend Capability Layer）

> 状态：draft v0.1
> 创建：2026-05-19
> 依赖：`docs/session-context-assembly.md`（上下文组装）、`docs/evolclaw-home-directory.md`（目录结构）

## 概述

前端（Evol App / Desktop / Web）是 agent 感知物理世界的窗口。通过前端能力层，agent 可以获取时间、位置、摄像头、通讯录等环境信息，极大增强对当前场景的理解和行动能力。

**核心安全原则**：
- 手机号**绝对不上传**到 agent 侧
- 具体人的通信（打电话、发短信、发微信）**只能由前端执行**，agent 只能发起请求，前端决定是否执行并需用户确认
- 敏感操作（支付、删除、权限变更）必须前端二次确认

## 前端类型与环境

前端类型是环境层的一部分，不同前端决定了 agent 可用的工具集：

| 前端类型 | 标识 | 典型场景 | 能力特征 |
|---|---|---|---|
| 手机 App（iOS/Android） | `mobile` | 移动办公、外出、随时随地 | GPS、摄像头、通讯录、通知、传感器 |
| 桌面客户端（Windows/macOS） | `desktop` | 深度工作、编码、文件处理 | 文件系统、剪贴板、屏幕截图、大文件 |
| 网页版（浏览器） | `web` | 轻量访问、临时使用 | 有限文件、地理位置（需授权）、通知 |

前端在连接时上报自身类型和能力清单，agent 据此决定可调用哪些工具。

## 环境信息增强

### 时间

| 信息 | 来源 | 注入方式 |
|---|---|---|
| 当前时间（精确） | 本地系统时钟 | runtime token: `[时间] 2026-05-19 04:15 CST` |
| 时区 | 前端上报 | runtime token: `[时区] Asia/Shanghai` |
| 日历事件（今日） | 前端获取（需授权） | 环境上下文补充 |

### 位置

| 信息 | 来源 | 精度 | 注入方式 |
|---|---|---|---|
| GPS 坐标 | 手机 App | 高 | 不直接注入，转为语义位置 |
| 语义位置 | 前端反地理编码 | — | `[位置] 北京市海淀区中关村` |
| Wi-Fi / IP 推断 | 桌面/网页 | 低 | `[位置] 北京市（粗略）` |
| 场所类型 | 前端 POI 识别 | — | `[场所] 办公室 / 咖啡厅 / 家` |

**隐私规则**：精确坐标不上传到 agent，前端在本地完成反地理编码后只上报语义位置（城市/区/街道级别）。

## 前端工具集设计

### 工具调用协议

agent 通过 AUN 消息向前端发起工具调用请求：

```jsonc
{
  "type": "tool_request",
  "tool": "camera.capture",
  "params": { "facing": "back", "flash": "auto" },
  "request_id": "req_abc123",
  "require_confirm": true    // 是否需要用户在前端确认
}
```

前端响应：

```jsonc
{
  "type": "tool_response",
  "request_id": "req_abc123",
  "status": "success",       // success | denied | unavailable | timeout
  "result": { ... }
}
```

### 通用工具（所有前端）

| 工具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 获取当前时间 | `env.time` | 返回精确时间 + 时区 | 否 |
| 获取位置（语义） | `env.location` | 返回语义位置（城市/区/街道） | 首次需授权 |
| 发送通知 | `notify.push` | 向用户推送通知 | 否 |
| 读取剪贴板 | `clipboard.read` | 读取当前剪贴板文本 | 是 |
| 写入剪贴板 | `clipboard.write` | 写入文本到剪贴板 | 否 |
| 打开 URL | `browser.open` | 在默认浏览器打开链接 | 否 |
| 文件选择 | `file.pick` | 让用户选择文件 | 是（用户主动选择） |
| 文件下载 | `file.download` | 下载文件到本地 | 否 |

### 手机 App 专属工具（mobile）

#### 摄像头与媒体

| 工具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 拍照 | `camera.capture` | 调起相机拍照并返回图片 | 是 |
| 录视频 | `camera.record` | 录制短视频（限时 60s） | 是 |
| 选择相册图片 | `media.pick_image` | 从相册选择图片 | 是（用户选择） |
| 选择相册视频 | `media.pick_video` | 从相册选择视频 | 是（用户选择） |
| 扫描二维码 | `camera.scan_qr` | 扫描并解析二维码内容 | 是 |
| OCR 识别 | `camera.ocr` | 拍照或选图后 OCR 提取文字 | 是 |

#### 通讯录

| 工具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 搜索联系人 | `contacts.search` | 按姓名搜索，返回姓名 + 备注（**不含手机号**） | 是 |
| 获取联系人详情 | `contacts.detail` | 返回姓名、公司、职位、邮箱、备注（**不含手机号**） | 是 |
| 查看最近通话 | `contacts.recent_calls` | 返回最近通话的联系人姓名 + 时间（**不含号码**） | 是 |

**安全硬约束**：
- 手机号字段在前端侧过滤，**永远不传给 agent**
- agent 无法获取完整通讯录列表，只能按条件搜索
- 返回结果上限 20 条

#### 通信（前端执行，agent 只能请求）

| 工具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 拨打电话 | `comm.call` | 请求前端拨打电话（按联系人姓名） | **强制确认** |
| 发送短信 | `comm.sms` | 请求前端发送短信（按联系人姓名 + 内容） | **强制确认** |
| 打开微信聊天 | `comm.wechat_open` | 打开与某人的微信对话 | **强制确认** |
| 打开邮件撰写 | `comm.email_compose` | 打开邮件客户端并预填内容 | 是 |

**通信安全模型**：
- agent 只提供"联系人姓名"和"意图"，**不接触实际号码/ID**
- 前端在本地解析姓名→号码的映射
- 所有通信操作必须用户在前端界面确认后才执行
- agent 收到的响应只有"已执行/已拒绝"，不含通信细节

#### 传感器

| 工具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 获取电量 | `sensor.battery` | 返回电量百分比 + 充电状态 | 否 |
| 获取网络状态 | `sensor.network` | Wi-Fi/蜂窝/离线 | 否 |
| 获取屏幕状态 | `sensor.screen` | 亮屏/息屏/锁定 | 否 |
| 获取运动状态 | `sensor.motion` | 静止/步行/驾驶/骑行 | 否 |

#### 日历与提醒

| 具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 查看今日日程 | `calendar.today` | 返回今日事件列表 | 是 |
| 创建日程 | `calendar.create` | 创建新日历事件 | 是 |
| 设置提醒 | `reminder.create` | 创建本地提醒 | 否 |

### 桌面客户端专属工具（desktop）

| 工具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 屏幕截图 | `screen.capture` | 截取当前屏幕或选区 | 是 |
| 窗口列表 | `screen.windows` | 列出当前打开的窗口标题 | 否 |
| 文件系统浏览 | `fs.browse` | 浏览指定目录（沙箱内） | 否 |
| 读取文件 | `fs.read` | 读取指定路径文件内容 | 是 |
| 写入文件 | `fs.write` | 写入文件到指定路径 | 是 |
| 执行命令 | `shell.exec` | 在本地终端执行命令（沙箱） | **强制确认** |
| 打开应用 | `app.launch` | 打开本地应用程序 | 是 |

### 网页版专属工具（web）

| 工具 | 标识 | 说明 | 需确认 |
|---|---|---|---|
| 浏览器地理位置 | `geo.browser` | 浏览器 Geolocation API | 首次授权 |
| 文件上传 | `file.upload` | 通过 `<input type="file">` 选择 | 用户主动 |
| 页面截图 | `screen.page` | 当前页面截图 | 否 |
| Web 通知 | `notify.web` | 浏览器通知 | 首次授权 |

## 能力协商机制

### 连接时上报

前端连接 evolclaw 时，在握手阶段上报能力清单：

```jsonc
{
  "type": "capability_report",
  "frontend_type": "mobile",        // mobile | desktop | web
  "platform": "ios",                // ios | android | windows | macos | linux | browser
  "version": "1.2.0",
  "capabilities": [
    "camera.capture",
    "camera.scan_qr",
    "contacts.search",
    "env.location",
    "env.time",
    "sensor.battery",
    "sensor.network",
    "calendar.today",
    "comm.call",
    "comm.sms"
  ],
  "permissions": {
    "location": "granted",          // granted | denied | not_asked
    "camera": "granted",
    "contacts": "not_asked",
    "calendar": "denied"
  }
}
```

### 注入环境上下文

能力清单注入 session 的环境层：

```
[前端] mobile (iOS 1.2.0)
[能力] 拍照, 扫码, 通讯录搜索, 定位, 日程查看, 拨打电话, 发短信
[权限受限] 日历（用户未授权）
```

agent 据此知道自己"能做什么"，不会尝试调用不可的工具。

## 工具调用流程

```
Agent 决定需要调用前端工具
    │
    ├─ 检查 capability_report 中是否包含该工具
    │   └─ 不包含 → 放弃，告知用户该功能在当前前端不可用
    │
    ├─ 检查权限状态
    │   └─ denied → 提示用户需要在设置中开启权限
    │
    ├─ 构造 tool_request 消息
    │   ├─ require_confirm: true → 前端弹出确认 UI
    │   └─ require_confirm: false → 前端静默执行
    │
    ├─ 通过 AUN 消息发送到前端
    │
    └─ 等待 tool_response（超时 30s）
        ├─ success → 处理结果，继续对话
        ├─ denied → 用户拒绝，agent 换方案或告知
        ├─ unavailable → 工具不可用（硬件故障等）
        └─ timeout → 超时，提示用户
```

## 安全分层

### 三级安全模型

| 级别 | 操作类型 | 确认方式 | 示例 |
|---|---|---|---|
| L0（静默） | 只读环境信息 | 无需确认 | 时间、电量、网络状态 |
| L1（轻确认） | 访问用户数据 | 前端 toast 提示 | 通讯录搜索、日历查看、拍照 |
| L2（强确认） | 对外通信/写操作 | 前端弹窗 + 明确按钮 | 打电话、发短信、发邮件、执行命令 |

### 数据过滤规则（前端侧执行）

| 数据类型 | 规则 | 原因 |
|---|---|---|
| 手机号 | **永不上传** | 隐私红线 |
| 身份证号 | **永不上传** | 隐私红线 |
| 银行卡号 | **永不上传** | 金融安全 |
| 密码/token | **永不上传** | 安全红线 |
| GPS 精确坐标 | 转为语义位置后上传 | 隐私保护 |
| 通讯录全量 | 禁止批量导出，只允许搜索 | 防数据泄露 |

### agent 侧约束

- agent **不存储**前端返回的敏感数据（图片可缓存，通讯录结果不缓存）
- agent **不转发**前端数据到第三方（除非用户明确指示）
- 工具调用日志记录在 `data/instance/aid-{pid}.jsonl`，可审计

## 与上下文组装的集成

前端能力层作为环境层的子层注入：

```
环境层（Venue Layer）
├── venue profile（群/私聊环境）
├── channel kit（通信约定）
├── 时间 + 位置（前端上报）        ← 新增
├── 前端类型 + 能力摘要            ← 新增
└── 场景模板
```

在 `session-context-assembly.md` 的组装流程中，Step 2（Resolve Venue）增加：

```
Step 2.5: Resolve Frontend Context
  - 从前 capability_report 提取 frontend_type / platform / capabilities
  - 从前端 env.time 获取精确时间
  - 从前端 env.location 获取语义位置（如已授权）
  - 组装为 frontend_context 注入环境层
```

## 实现路径

### Phase 1：协议定义 + 时间/位置

1. 定义 `tool_request` / `tool_response` 消息格式（AUN message 扩展）
2. 前端连接时上报 `capability_report`
3. 实现 `env.time` + `env.location` 注入环境层
4. evolclaw 侧：解析 capability_report，注入 runtime token

### Phase 2：手机 App 核心工具

1. 实现 `camera.capture` / `media.pick_image`（拍照/选图）
2. 实现 `contacts.search` / `contacts.detail`（通讯录，过滤手机号）
3. 实现 `comm.call` / `comm.sms`（通信请求，强制确认）
4. 前端 UI：工具确认弹窗、权限引导

### Phase 3：桌面 + 网页工具

1. 桌面：`screen.capture` / `fs.read` / `fs.write` / `shell.exec`
2. 网页：`geo.browser` / `file.upload` / `notify.web`
3. 统一工具调用超时和错误处理

### Phase 4：高级能力

1. `camera.ocr`（OCR 识别）
2. `calendar.today` / `calendar.create`（日历集成）
3. `sensor.motion`（运动状态感知）
4. 工具组合编排（如：拍照 → OCR → 搜索联系人 → 发邮件）

## 手机前端惊艳能力扩展

基于上述工具集，手机前端还可以提供以下惊艳能力：

### 视觉增强
- **实时物体识别**：`vision.identify` — 摄像头实时流 + AI识别（植物/动物/商品/车型）
- **AR测量**：`ar.measure` — 用AR测距离、面积、高度（装修/买家具场景）
- **文档扫描+矫正**：`scan.document` — 拍歪的文件自动透视矫正+去阴影+OCR
- **实时翻译取词**：`vision.translate` — 摄像头对准外文，实时叠加翻译
- **人脸情绪识别**：`vision.emotion` — 识别微表情（需伦理边界）

### 音频能力
- **环境音识别**：`audio.ambient` — 识别环境声音（咖啡厅/办公室/街道/自然）
- **实时语音转写**：`audio.transcribe` — 会议记录，边说边转文字
- **声纹识别**：`audio.voiceprint` — 识别说话人身份（已授权联系人）
- **降噪提取**：`audio.denoise` — 嘈杂环境提取清晰人声
- **音乐识别**：`audio.recognize_music` — 听歌识曲 + 歌词同步

### 传感器魔法
- **手电筒控制**：`flashlight.control` — 开关 + 闪烁模式（SOS/摩斯密码）
- **震动反馈**：`haptic.feedback` — 触觉反馈（重要消息强震动）
- **气压计**���`sensor.pressure` — 判断楼层/海拔变化
- **陀螺仪手势**：`sensor.gesture` — 摇一摇/画圈/敲击识别
- **距离传感器**：`sensor.proximity` — 手机靠近耳朵自动切换语音模式
- **光线传感器**：`sensor.light` — 环境亮度 → 推断室内/室外/时段

### 通信增强
- **NFC读写**：`nfc.read` / `nfc.write` — 读门禁卡/公交卡余额、写NFC标签
- **蓝牙设备扫描**：`bluetooth.scan` — 发现周围设备（耳机/手环/智能家居）
- **Wi-Fi热点分析**：`wifi.scan` — 周围Wi-Fi信号 → 推断位置类型
- **AirDrop/快传**：`transfer.quick` — 跨设备快速传文件
- **超声波通信**：`ultrasonic.exchange` — 手机间近场数据交换（无需网络）

### 生物识别
- **心率检测**：`health.heart_rate` — 手指按摄像头测心率
- **步数/运动轨迹**：`health.activity` — 健康数据读取
- **睡眠监测**：`health.sleep` — 夜间传感器数据分析
- **呼吸引导**：`health.breathing` — 震动+声音引导深呼吸

### 智能场景
- **快捷指令触发**：`shortcuts.run` — 调用iOS Shortcuts/Android Tasker
- **应用使用统计**：`usage.stats` — 今天用了哪些app多久
- **勿扰模式控制**：`focus.control` — 开关勿扰/专注模式
- **闹钟/定时器**：`alarm.set` — 设置智能闹钟
- **电池优化建议**：`battery.optimize` — 分析耗电app

### 创意交互
- **截屏 + 标注**：`screen.annotate` — 截图后自动标注重点
- **录屏 + 剪辑**：`screen.record_edit` — 录制操作教程，自动剪掉停顿
- **语音备忘录**：`voice.memo` — 随时语音记录，agent整理成文字
- **涂鸦识别**：`sketch.recognize` — 手写/画图 → 识别意图
- **摇一摇反馈**：`gesture.shake` — 遇到问题摇手机，agent主动询问

### 隐私安全
- **应用权限审计**：`privacy.audit` — 哪些app有敏感权限
- **剪贴板监控**：`clipboard.monitor` — 复制敏感信息时提醒
- **屏幕时间报告**：`usage.report` — 每日使用总结
- **隐私模式**：`privacy.lockdown` �� 一键关闭所有传感器/摄像头权限

## 与群Skill架构的集成

本文档定义的前端工具集是**群Skill架构**（`docs/group-skill-architecture.md`）的基础能力层：

- 前端工具 = venue skill registry 中的 tool 类型能力
- 前端连接时自动注册到所有参与的 venue
- 其他成员（agent/人）可以通过授权调用这些工具
- 单聊 = 二人群，主人前端的工具同样可被 agent 调用

详细的调用流程、授权机制、安全模型见 `docs/group-skill-architecture.md`。

## 开放问题

1. **工具调用是否走 AUN 协议还是独立通道**：当前设计走 AUN message，但工具调用的实时性要求高，是否需要专用 WebSocket channel？

2. **前端离线时的降级**：前端断开后 agent 如何感知？是否需要 heartbeat 机制？

3. **多前端同时在线**：用户同时开着手机和桌面，工具请求发给哪个前端？建议：按工具类型路由（camera → mobile，fs → desktop），或让用户指定。

4. **图片/文件的传输方式**：大文件是否走 AUN storage 服务？还是前端直接 base64 内联？建议：小文件（<1MB）内联，大文件走 storage 上传后返回 URL。

5. **工具调用频率限制**：防止 agent 过度调用前端工具（如循环拍照）。建议：每分钟上限 10 次工具调用，L2 操作每分钟上限 2 次。
