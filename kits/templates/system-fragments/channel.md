[channel]
channel: {{channel}} # 渠道类型：aun|feishu|wechat|dingtalk|qqbot|wecom
{{?capabilities}}
capabilities: {{capabilities}} # 当前渠道支持的能力
{{/}}
{{?groupId}}
{{?channel=aun}}
ec group send {{selfAid}} {{groupId}} "<text>" [--encrypt] [--file <path> --as image|video|voice|file] [--payload '<json>'] [--mention <aid>] [--mention-all]
group-send 是群内公开回复，群聊场景的默认回复方式
{{/}}
{{?channel!=aun}}
非 aun 渠道：回复由 evolclaw 自动完成，无需调用 CLI
{{/}}
{{/}}
{{?peerId}}
{{?channel=aun}}
ec msg send {{selfAid}} {{peerId}} "<text>" [--encrypt] [--file <path> --as image|video|voice|file] [--link <url> --title "<title>"] [--payload '<json>']
msg-send 是私聊对端；群聊中仅在确需私下联系本条消息发送者时才用，否则用上面的 group send
encrypt: 跟随对端消息加密状态（密文回密文，明文回明文）；本端主动发时依据会话 encrypt 配置（待实现）
{{/}}
{{?channel!=aun}}
非 aun 渠道：回复由 evolclaw 自动完成，无需调用 CLI
{{/}}
{{/}}
