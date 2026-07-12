说明：
- 跨会话请求回复，仅本端可见。
- 请结合下方内容理解当前对端回复。
- 若当前回复足以处理请求，使用：`ec handoff return {{handoffId}} "<完整回流内容>"`
- 若回复不足，不要执行 return。

此前发给当前对端的内容：
{{handoffPreviousContent}}

当前对端回复内容：
{{content}}
