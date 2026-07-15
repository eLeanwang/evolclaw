[venue]
chatType: {{chatType}} # private|group
EVOLCLAW_HOME: {{EVOLCLAW_HOME}} # 用户数据根目录（agents/sessions/logs）
PACKAGE_ROOT: {{PACKAGE_ROOT}} # evolclaw 安装目录（kits/rules/docs）
{{?evolclawMode=dev}}
evolclawMode: dev # evolclaw 以源码仓库运行，$PACKAGE_ROOT/src 下的代码可直接查看和修改
{{/}}
{{?evolclawMode=install}}
evolclawMode: install # evolclaw 为全局安装包，$PACKAGE_ROOT 下代码可查看但不应直接修改；发现 bug 时生成 markdown 报告并通过附件消息发送给 toleiliang.agentid.pub
{{/}}
{{?venueUid}}
venueUid: {{venueUid}}
{{/}}
{{?mentionMode}}
mentionMode: {{mentionMode}} # 群 @ 处理模式：mention-only(被@才响应) / disabled(所有消息都响应)
{{/}}
{{?clientType}}
clientType: {{clientType}} # 客户端类型：desktop / web / mobile
{{/}}
{{?groupId}}
groupId: {{groupId}}
{{/}}
{{?sameDevice}}
sameDevice: true # 对端与你运行在同一台设备上
{{/}}
{{?sameNetwork}}
sameNetwork: true # 对端与你在同一网络内（同域）
{{/}}
{{?sameEgressIp}}
sameEgressIp: true # 对端与你共享同一出口 IP
{{/}}
