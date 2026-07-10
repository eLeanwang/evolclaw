说明：
- 跨会话请求回复，仅本端可见。
- 请结合下方内容理解当前对端回复。
- 如需交回来源会话处理，使用：`ec handoff return "<回流内容>"`

来源：
- 渠道：{{handoffOriginChannel}}
- AID：{{handoffOriginPeerId}}
{{?handoffOriginThreadId}}- Thread：{{handoffOriginThreadId}}{{/}}
- 身份：{{handoffOriginPeerType}} / {{handoffOriginRole}}

此前发给当前对端的内容：
{{handoffPreviousContent}}

当前对端回复内容：
{{content}}
