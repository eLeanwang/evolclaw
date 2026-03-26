** 概述 **

`scripts/feishu-lark-auth-flow.mjs` 是一个从
`@larksuite/openclaw-lark-tools` 抽取出来的独立脚本。

它只保留 3 段核心能力：

1. 生成并输出终端二维码
2. 发起飞书/Lark 扫码注册流程
3. 在扫码成功后拿到 `appId` 和 `appSecret`

脚本是单文件，可直接复制到纯 Node 22+ 环境运行。
如果环境里没有 `qrcode-terminal`，脚本会自动降级为打印扫码 URL，
不会因为缺依赖直接报错退出。


** 文件位置 **

- 脚本：`scripts/feishu-lark-auth-flow.mjs`
- 测试：`test/scripts/feishu-lark-auth-flow.test.ts`


** 返回结果 **

成功时返回：

```json
{
  "appId": "cli_xxx",
  "appSecret": "sec_xxx",
  "domain": "feishu",
  "userInfo": {
    "openId": "ou_xxx"
  }
}
```


** 直接运行 **

要求：

- Node 22+
- 网络可访问飞书/Lark 账号注册接口

运行方式：

```bash
node scripts/feishu-lark-auth-flow.mjs --json
```

可选参数：

- `--env prod|boe|pre`
- `--lane <lane>`
- `--debug`
- `--json`
- `--no-qr`

示例：

```bash
node scripts/feishu-lark-auth-flow.mjs --env prod --json
```

如果你只想拿扫码链接，不想在终端打印二维码：

```bash
node scripts/feishu-lark-auth-flow.mjs --no-qr --json
```


** 代码调用 **

可以直接导入下面 3 个导出：

- `printQRCode(url, renderer?)`
- `FeishuQrRegistrationClient`
- `runQrRegistrationFlow(options?)`

最小示例：

```js
import { runQrRegistrationFlow } from "./scripts/feishu-lark-auth-flow.mjs";

const result = await runQrRegistrationFlow({
  env: "prod",
});

console.log(result.appId);
console.log(result.appSecret);
```


** 二维码输出 **

如果你想自己接管二维码展示，而不是让脚本直接往终端打印，
可以传 `qrRenderer`：

```js
import { runQrRegistrationFlow } from "./scripts/feishu-lark-auth-flow.mjs";

const result = await runQrRegistrationFlow({
  qrRenderer(url) {
    console.log("扫码链接:", url);
  },
});
```


** 自定义网络层 **

如果你在测试环境里不想真的发网络请求，可以传 `fetchImpl`：

```js
import { runQrRegistrationFlow } from "./scripts/feishu-lark-auth-flow.mjs";

const result = await runQrRegistrationFlow({
  fetchImpl: async (input, init) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
```


** 轮询逻辑 **

脚本内部流程如下：

1. `init()` 请求注册能力
2. `begin()` 获取 `verification_uri_complete` 和 `device_code`
3. 输出二维码或扫码 URL
4. 显示快捷键提示
5. 按 `interval` 轮询 `poll(device_code)`
6. 如果返回 `client_id` 和 `client_secret`，立即结束并返回

快捷键（二维码显示期间可用）：

- `q` 或 `Ctrl+C`：退出，不再等待扫码
- `s`：跳过扫码，进入手动输入 appId/appSecret 模式

错误处理规则：

- `authorization_pending`：继续等待
- `slow_down`：轮询间隔加 5 秒
- `access_denied`：抛错退出
- `expired_token`：抛错退出
- 其他 `error`：抛错退出


** 注意事项 **

1. 这个脚本只负责扫码注册与返回凭证，不负责写入
   `~/.openclaw/openclaw.json`。
2. 如果你还要把结果写入 OpenClaw 配置，请在外层自己处理持久化。
3. 默认会先走飞书域名；如果轮询结果里识别到 `tenant_brand === "lark"`，
   后续会自动切到 Lark 域名继续请求。
