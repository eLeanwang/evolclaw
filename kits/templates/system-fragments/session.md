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
