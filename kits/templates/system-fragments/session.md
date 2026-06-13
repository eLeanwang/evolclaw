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
{{?localDate}}
localDate: {{localDate}} {{weekday}} # 当前日期与星期（每条消息的精确时刻见消息正文前缀 ‹…›）
{{/}}
{{?timezone}}
timezone: {{timezone}} # 时区 IANA 名：把消息/记忆里的 ISO 时间戳转成本地时间字符串时按此换算
{{/}}
{{?tzOffset}}
tzOffset: {{tzOffset}} # 当前 UTC 偏移（DST 已计入）
{{/}}
{{?osInfo}}
os: {{osInfo}} # 当前操作系统及版本
{{/}}
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
# 要正式回复对端，必须显式调用发送命令：
{{?chatType=group}}
#   群聊：ec group send {{selfAid}} {{groupId}} "<text>" [--file <path> --as <type>] [--mention <aid>]
{{/}}
{{?chatType=private}}
#   私聊：ec msg send {{selfAid}} {{peerId}} "<text>" [--file <path> --as <type>]
{{/}}
# 收到消息后第一时间发送一条消息说明你的意图，不要闷头干；执行超过 10 次工具调用需再发一次汇报情况和意图。
{{/}}
