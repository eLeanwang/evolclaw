[session]
project: {{project}} # 项目目录名
CURRENT_PROJECT: {{CURRENT_PROJECT}} # 项目完整路径
sessionId: {{sessionId}} # evolclaw 会话 ID
{{?sessionName}}
sessionName: {{sessionName}}
{{/}}
sessionCreatedAt: {{sessionCreatedAt}}
chatMode: {{chatMode}} # interactive=同步对话 / proactive=主动推送（输出静默）
{{?threadId}}
threadId: {{threadId}} # 同一会话内的子话题 ID（多话题路由时）
{{/}}
{{?readonly}}
readonly: true — 禁止修改项目文件，如需生成文件请写入 .evolclaw/tmp/
{{/}}
{{?chatMode=proactive}}
# proactive 模式：文本输出静默丢弃，必须用以下命令发消息
proactive-send: evolclaw ctl send "<text>"
proactive-file: evolclaw ctl file <path>
{{/}}
