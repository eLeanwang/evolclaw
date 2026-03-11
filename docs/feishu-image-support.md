# 飞书图片支持说明

## 当前状态

飞书图片消息已经可以接收，但下载图片时遇到 400 错误。

## 问题原因

飞书 API 返回 400 错误，原因是：

1. **权限不足**：应用需要 `im:resource` 权限才能下载图片
2. **API 调用方式**：飞书图片下载 API 可能需要特殊的认证方式

## 需要的权限

在飞书开放平台配置应用权限：

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 进入你的应用
3. 点击"权限管理"
4. 添加以下权限：
   - `im:resource` - 获取与上传图片或文件资源
   - `im:message` - 获取与发送单聊、群组消息（已有）
   - `im:message.group_msg` - 获取群组消息（已有）
5. 保存并发布新版本

## 技术细节

### 当前实现

```typescript
// 接收图片消息
if (msg.message_type === 'image') {
  const imageKey = JSON.parse(msg.content).image_key;

  // 尝试下载图片
  const response = await this.client.im.image.get({
    path: { image_key: imageKey }
  });
}
```

### 错误信息

```
HTTP 400 Bad Request
Content-Type: application/json
```

这表明 API 返回的是错误信息而不是图片数据。

## 解决方案

### 方案 1：配置权限（推荐）

1. 在飞书开放平台添加 `im:resource` 权限
2. 重新发布应用
3. 重启 EvolClaw 服务

### 方案 2：使用文件路径（临时方案）

用户可以：
1. 将图片保存到服务器
2. 告诉 Claude 图片的文件路径
3. Claude 使用 Read 工具读取图片

示例：
```
用户: 请分析这张图片 /home/user/screenshot.png
Claude: [使用 Read 工具读取并分析图片]
```

## 代码位置

- 图片消息处理：`src/channels/feishu.ts:45-60`
- 图片下载方法：`src/channels/feishu.ts:130-170`

## 测试步骤

配置权限后：

1. 重启服务
2. 在飞书发送图片
3. 查看日志：`tail -f /tmp/evolclaw.log`
4. 应该看到：`[Feishu] Image saved to: ...`

## 参考文档

- [飞书开放平台 - 图片消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json#45e0953e)
- [飞书开放平台 - 下载图片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/get)
- [飞书开放平台 - 权限列表](https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN)
