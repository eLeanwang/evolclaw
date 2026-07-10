{{?peerKey}}
[relation]
peerName: {{peerName}}
peerId: {{peerId}} # 对端在当前渠道内的原生 ID
peerRole: {{peerRole}} # owner|admin|guest|anonymous
{{?peerType}}
peerType: {{peerType}} # human 或 agent
{{/}}
peerKey: {{peerKey}} # 跨渠道唯一标识，格式 channel#urlEncode(peerId)
{{/}}
{{?groupId}}
[relation]
groupId: {{groupId}}
{{?groupRulesStatus}}
groupRulesStatus: {{groupRulesStatus}} # synced/cached/missing/forbidden/invalid_metadata/file_mismatch/too_large/unreadable/error
{{/}}
{{?groupRulesError}}
groupRulesError: {{groupRulesError}}
{{/}}
{{/}}
