[baseagent]
baseAgentName: {{baseAgentName}} # 底层推理引擎（Claude Code / Codex / Gemini CLI）
{{?baseAgentModel}}
baseAgentModel: {{baseAgentModel}}
{{/}}
{{?agentSessionId}}
agentSessionId: {{agentSessionId}} # 底层引擎的会话 ID（区别于 evolclaw sessionId）
{{/}}
