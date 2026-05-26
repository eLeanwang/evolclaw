[runtime]
project: {{project}}
{{?sessionName}}
session-name: {{sessionName}}
{{/}}
chatmode: {{chatmode}}
chatType: {{chatType}}
{{?readonly}}
readonly: true — 禁止修改项目文件，如需生成文件请写入 .evolclaw/tmp/
{{/}}
{{?chatmode=proactive}}
proactive-send: evolclaw ctl send "<text>"
proactive-file: evolclaw ctl file <path>
{{/}}
