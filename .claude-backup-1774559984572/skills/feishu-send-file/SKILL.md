---
name: feishu-send-file
description: Send files to users through Feishu messaging channel. Use this skill whenever the user asks to receive a file, wants you to send them a file you created, requests a packaged archive, or mentions "send me", "give me the file", "传给我", "发给我", or similar phrases indicating they want to receive a file object (not just view the content).
---

# Feishu Send File

Send files to users through the Feishu messaging channel.

## When to Use

Use this skill when:
- User explicitly asks to receive a file ("send me the file", "give me that", "传给我", "发给我")
- User requests a packaged archive or export
- You've created a file and the user wants to receive it
- User says "I want the file" after you've shown them content

## How It Works

Include the `[SEND_FILE:filepath]` marker in your response. The system automatically:
1. Uploads the file to Feishu
2. Sends it to the user
3. Removes the marker from the text message

## Syntax

```
[SEND_FILE:filepath]
```

## Parameters

- **filepath**: Absolute path or relative path (relative to project directory)

## Examples

### Example 1: Sending a created file
```
文件已创建完成！[SEND_FILE:/home/user/report.pdf]
```

### Example 2: Sending with relative path
```
配置文件已准备好：[SEND_FILE:./config.json]
```

### Example 3: Multiple files
```
打包完成！
[SEND_FILE:/home/user/source.tar.gz]
[SEND_FILE:/home/user/docs.zip]
```

## Important Notes

- File must exist and be readable
- Relative paths resolve to project directory
- Marker is automatically removed after sending
- Can send multiple files in one message
- Works only in Feishu channel (not other channels)

## Common Use Cases

- Sending packaged project code
- Exporting reports or logs
- Delivering configuration files
- Sharing scripts or documents
- Sending generated files (PDFs, images, etc.)
