[session]
project: {{project}} # 项目目录名
CURRENT_PROJECT: {{CURRENT_PROJECT}} # 项目完整路径
sessionId: {{sessionId}} # evolclaw 会话 ID
{{?sessionKey}}
sessionKey: {{sessionKey}} # 会话路由键（channelType#urlEncode(channelId)#urlEncode(threadId)）
{{/}}
{{?sessionName}}
sessionName: {{sessionName}}
{{/}}
sessionCreatedAt: {{sessionCreatedAt}}
chatMode: {{chatMode}} # interactive=同步对话 / proactive=主动推送（输出静默）
{{?permissionMode}}
permissionMode: {{permissionMode}} # auto / bypass / request / edit / plan / noask / readonly
{{/}}
{{?threadId}}
threadId: {{threadId}} # 同一会话内的子话题 ID（多话题路由时）
{{/}}
{{?readonly}}
readonly: true — 禁止修改项目文件，如需生成文件请写入 .evolclaw/tmp/
{{/}}
{{?chatMode=proactive}}
# proactive 模式：你的普通文本会作为"思考过程"实时展示给用户（可见，但不入消息历史、不是回复）。
# 要正式回复对端，必须显式调用发送命令（命令集见 06-channel）。
proactive-send: ec msg send {{selfAid}} {{peerId}} "<text>"   # 拿不到 self-aid 时退回 ec ctl send "<text>"
proactive-file: ec msg send {{selfAid}} {{peerId}} --file <path> --as <image|video|voice|file>
{{/}}
