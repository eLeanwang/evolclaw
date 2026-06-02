[channel]
channel: {{channel}} # 渠道类型：aun|feishu|wechat|dingtalk|qqbot|wecom
{{?capabilities}}
capabilities: {{capabilities}} # 当前渠道支持的能力
{{/}}
{{?peerId}}
{{?channel=aun}}
ec msg send {{selfAid}} {{peerId}} "<text>" [--encrypt] [--file <path> --as image|video|voice|file] [--link <url> --title "<title>"] [--payload '<json>']
encrypt: 跟随对端消息加密状态（密文回密文，明文回明文）；本端主动发时依据会话 encrypt 配置（待实现）
{{/}}
{{?channel!=aun}}
非 aun 渠道：回复由 evolclaw 自动完成，无需调用 CLI
{{/}}
{{/}}
{{?groupId}}
{{?channel=aun}}
ec group send {{selfAid}} {{groupId}} "<text>" [--encrypt] [--file <path> --as image|video|voice|file] [--payload '<json>'] [--mention <aid>] [--mention-all]
{{/}}
{{?channel!=aun}}
非 aun 渠道：回复由 evolclaw 自动完成，无需调用 CLI
{{/}}
{{/}}
