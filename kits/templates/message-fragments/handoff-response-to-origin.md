[跨会话回复上下文，仅本端可见]

说明：
- 另一会话已经根据此前的 `ec msg send` 得到回复。
- 这是给当前会话的跨会话结果回流，请结合下方内容和当前用户消息继续处理。
- 不要再次提示“需要通过 msg send 回复原会话”，除非用户明确要求继续追问结果来源。
- 如果用户明确要求继续追问结果来源，使用：`{{handoffContinueCommand}}`

来源：
- 结果来源渠道：{{handoffOriginChannel}}
- 结果来源 AID：{{handoffOriginPeerId}}
{{?handoffOriginThreadId}}- 结果来源 Thread：{{handoffOriginThreadId}}{{/}}
{{?handoffOriginPeerName}}- 结果来源名称：{{handoffOriginPeerName}}{{/}}
- 结果来源身份：{{handoffOriginPeerType}} / {{handoffOriginRole}}

回流内容：
{{handoffPreviousContent}}

当前用户消息内容：
{{content}}
