[baseagent]
baseAgentName: {{baseAgentName}} # 底层推理引擎（Claude Code / Codex / Gemini CLI）
{{?effectiveModel}}
effectiveModel: {{effectiveModel}} # 当前实际生效的模型（关系级 > agent级 > 全局 优先级解析）
{{/}}
{{?baseAgentModel}}
baseAgentModel: {{baseAgentModel}} # base agent 引擎底座模型（evolclaw 作用域无配置时的兜底）
{{/}}
{{?modelFallbackActive}}
modelFallbackActive: true # evolclaw 配置的模型不可用，当前正在使用降级模型 {{modelFallbackModel}}
{{/}}
{{?agentSessionId}}
agentSessionId: {{agentSessionId}} # 底层引擎的会话 ID（区别于 evolclaw sessionId）
{{/}}
