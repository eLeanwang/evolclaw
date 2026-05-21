# 飞书渠道

<!-- TODO: 填充飞书渠道接入文档 -->

## 概述

飞书渠道通过 evolclaw 的 feishu channel 实现，支持：
- 单聊消息收发
- 群聊消息收发
- 合并转发消息解析
- 文件/图片/视频消息

## 配置

在 evolclaw 配置中启用飞书渠道：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "<app-id>",
      "appSecret": "<app-secret>"
    }
  }
}
```
