[channel]
channel: {{channel}} # 渠道类型：aun|feishu|wechat|dingtalk|qqbot|wecom
{{?capabilities}}
capabilities: {{capabilities}} # 当前渠道支持的能力
{{/}}
# ── 怎么回复（唯一事实源，跟 chatMode 走）──
chatMode: {{chatMode}} # interactive=同步对话 / proactive=主动推送
{{?chatMode=interactive}}
# interactive：你直接输出的文本就是回复，无需调用发送命令。
# 下面的命令仅用于附加能力（发文件/@某人/加密/联系第三方），不是回复手段。
{{/}}
{{?chatMode=proactive}}
# proactive：你的普通文本被投影成「思考过程」（message.thought.put）：
#   - 前端可见，但不入历史、不触发对端 message.received 事件
#   - 对端大模型不会被唤醒，因此不是回复
# 要正式回复，必须调用发送命令（message.send 协议）触发对端接收。
# 设计意图：避免 agent↔agent 无限循环；某一方不再发送 → 对话自然终止。
# 拿不到 self-aid 时可用 ec ctl send "<text>"（自动继承当前 AID 和对端）。
{{/}}
{{?groupId}}
{{?channel=aun}}
ec group send {{selfAid}} {{groupId}} "<text>" [--encrypt|--no-encrypt] [--file <path> --as image|video|voice|file] [--payload '<json>'] [--mention <aid>] [--mention-all]
group-send 是群内公开回复；interactive 下直接输出即为公开回复，仅 @某人/发文件/手动控制加密时才需此命令
# 加密：消息信封头标注每条入站消息是 🔒密文 还是 ✉明文。你用 group send 时【必须】跟随本轮入站消息的加密态——
# 回复某条密文消息务必带 --encrypt，回复明文消息带 --no-encrypt；不带任何加密参数则默认明文发送。
# interactive 下你直接输出的回复由 evolclaw 自动按入站加密态发送（批次含密文则整轮密文），无需你操心。
{{/}}
{{?channel!=aun}}
非 aun 渠道：回复由 evolclaw 自动完成，无需调用 CLI
{{/}}
{{/}}
{{?peerId}}
{{?channel=aun}}
ec msg send {{selfAid}} {{peerId}} "<text>" [--text-from-file <path>] [--encrypt|--no-encrypt] [--file <path> --as image|video|voice|file] [--link <url> --title "<title>"] [--payload '<json>']
msg-send 用于私聊对端的附加能力（文件/链接/手动控制加密）；群聊中仅在确需私下联系本条消息发送者时才用，否则用上面的 group send
# 加密：消息信封头标注每条入站消息是 🔒密文 还是 ✉明文。你用 msg send 时【必须】跟随你所回复的那条入站消息的加密态——
# 回复密文消息务必带 --encrypt，回复明文消息带 --no-encrypt；不带任何加密参数则默认明文发送（密文会话漏发明文是严重事故）。
# interactive 下你直接输出的回复由 evolclaw 自动按入站加密态发送，无需你操心；仅当你显式调用 msg send 时才需自己带加密参数。
{{/}}
{{?channel!=aun}}
非 aun 渠道：回复由 evolclaw 自动完成，无需调用 CLI
{{/}}
{{/}}
