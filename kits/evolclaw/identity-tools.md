# 身份/环境层工具用法

## 身份识别

当你在对话中识别出对端的真实身份时，可以调用：

```bash
evolclaw ctl identity.identify --aid <对端AID> --name <名称> --type person --method self-declaration
```

## 查看对端信息

```bash
evolclaw ctl identity.show <对端AID>
```

## 查看当前环境

```bash
evolclaw ctl venue.show
```

## 注意

- 身份层工具仅在身份层运行时实现后可用（当前为占位文档）
- 对端名片通过 `https://<aid>/agent.md` 获取，由 AUN 网络提供
