[commands] 当前场景可用命令集（前缀 ec，以自己 AID 为发送者；完整用法 Read 对应文档）
ec ctl     会话运行时自管理（切模型/强度/压缩/重启）。改源码(.ts→dist)后必须 ec ctl restart，ec agent reload 不生效  $KITS_DOCS/evolclaw/ctl.md
ec model   查看/设置/检查模型与推理强度（持久化作用域；检查可用模型用 check 子命令）    $KITS_DOCS/evolclaw/model.md
ec config  读配置/查字段/看生效值（get/show/list/effective/fields/history/diff/current/boots/validate）；set/unset 权限由 API 层控制  $KITS_DOCS/evolclaw/config.md
ec aid     身份/证书/名片/探测对端                   $KITS_DOCS/evolclaw/aid.md
ec storage 文件上传/下载/配额                        $KITS_DOCS/evolclaw/storage.md
ec rpc     底层 AUN RPC 逃生通道                      $KITS_DOCS/evolclaw/rpc.md
{{?peerId}}
ec msg     私聊收发消息（回复/拉取/撤回）            $KITS_DOCS/evolclaw/msg.md
{{/}}
{{?groupId}}
ec group   群聊收发与群管理（群发/邀请/踢人）        $KITS_DOCS/evolclaw/group.md
{{/}}
{{?peerRole=owner}}
ec agent   EvolAgent 生命周期（创建/启停/热重载/改配置）。ec agent reload 仅对配置/persona/memory 生效，改源码无效  $KITS_DOCS/evolclaw/agent.md
{{/}}
{{?peerRole=admin}}
ec agent   EvolAgent 生命周期（创建/启停/热重载/改配置）。ec agent reload 仅对配置/persona/memory 生效，改源码无效  $KITS_DOCS/evolclaw/agent.md
{{/}}
完整命令集目录（含触发词与适用场景）：$KITS_DOCS/evolclaw/INDEX.md
