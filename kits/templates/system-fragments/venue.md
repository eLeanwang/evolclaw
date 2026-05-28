[venue]
chatType: {{chatType}} # private|group
EVOLCLAW_HOME: {{EVOLCLAW_HOME}} # 用户数据根目录（agents/sessions/logs）
PACKAGE_ROOT: {{PACKAGE_ROOT}} # evolclaw 安装目录（kits/rules/docs）
{{?venueUid}}
venueUid: {{venueUid}}
{{/}}
{{?dispatch}}
dispatch: {{dispatch}} # 群分发模式：mention(被@才响应) / broadcast(所有消息都响应)
{{/}}
{{?clientType}}
clientType: {{clientType}} # 客户端类型：desktop / web / mobile
{{/}}
{{?groupId}}
groupId: {{groupId}}
{{/}}
