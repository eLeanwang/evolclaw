[commands] 当前场景可用命令集（前缀 ec，以自己 AID 为发送者；完整用法 Read 对应文档）
遇到明确触发词（费用/用量/统计/创建agent/建群/查群等）优先查 INDEX.md 或直接试对应 ec 命令

ec ctl     会话运行时自管理（切模型/强度/压缩/重启）。改源码(.ts→dist)后必须 ec ctl restart，ec agent reload 不生效  $KITS_DOCS/evolclaw/ctl.md
ec model   查看/设置/检查模型与推理强度（持久化作用域；检查可用模型用 check 子命令）    $KITS_DOCS/evolclaw/model.md
ec response 响应模式管理（切换响应模式/列响应模式/看当前模式/改响应配置）  $KITS_DOCS/evolclaw/response.md
ec stats   Token 用量与费用统计（用量/费用/统计/预算/token/cost）  $KITS_DOCS/evolclaw/stats.md
ec config  读配置/查字段/看生效值（get/show/list/effective/fields/history/diff/current/boots/validate）；set/unset 权限由 API 层控制  $KITS_DOCS/evolclaw/config.md
ec trigger 定时与事件触发器管理（定时任务/cron/提醒/自动执行/巡检/禁用/删除）。需要写操作的无人值守任务用 --permission bypass；单个 trigger 可用 --model/--effort 覆盖执行模型/强度  $KITS_DOCS/evolclaw/trigger.md
ec aid     身份/证书/名片/探测对端                   $KITS_DOCS/evolclaw/aid.md
ec fs      AUN 文件系统统一入口（ls/stat/cat/cp/mv/rm/mkdir/ln/chmod/setfacl/getfacl/token/find/df/mount/approve/reject/umount；个人/群空间同一入口；没有 ec group fs） $KITS_DOCS/evolclaw/fs.md
ec storage 文件上传/下载/配额（底层调试入口，日常优先 ec fs） $KITS_DOCS/evolclaw/storage.md
ec rpc     底层 AUN RPC 逃生通道                      $KITS_DOCS/evolclaw/rpc.md
{{?peerId}}
ec msg     私聊收发消息（回复/拉取/撤回）            $KITS_DOCS/evolclaw/msg.md
{{/}}
{{?selfAid}}
ec group   群聊收发与群管理（群发/建群/查群/邀请/踢人/角色/封禁/规则；高级 group.* 用 ec rpc） $KITS_DOCS/evolclaw/group.md
{{/}}
{{?peerRole=owner}}
ec agent   EvolAgent 生命周期（创建/启停/热重载/改配置）。ec agent reload 仅对配置/persona/memory 生效，改源码无效  $KITS_DOCS/evolclaw/agent.md
{{/}}
{{?peerRole=admin}}
ec agent   EvolAgent 生命周期（创建/启停/热重载/改配置）。ec agent reload 仅对配置/persona/memory 生效，改源码无效  $KITS_DOCS/evolclaw/agent.md
{{/}}
完整命令集目录（含触发词与适用场景）：$KITS_DOCS/evolclaw/INDEX.md
