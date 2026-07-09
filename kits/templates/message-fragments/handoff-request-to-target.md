[跨会话请求上下文，仅本端可见]

说明：
- 这条消息是当前对端对本端此前主动 `ec msg send` 的回复。
- 请结合下方“此前发给当前对端的内容”和“当前对端回复内容”理解当前回复。
- 需要把结果反馈给来源端时，使用：`{{handoffReplyCommand}}`

来源：
- 来源渠道：{{handoffOriginChannel}}
- 来源 AID：{{handoffOriginPeerId}}
{{?handoffOriginThreadId}}- 来源 Thread：{{handoffOriginThreadId}}{{/}}
{{?handoffOriginPeerName}}- 来源名称：{{handoffOriginPeerName}}{{/}}
- 来源身份：{{handoffOriginPeerType}} / {{handoffOriginRole}}

此前发给当前对端的内容：
{{handoffPreviousContent}}

当前对端回复内容：
{{content}}
