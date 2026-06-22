# AUN SDK 重构修改清单

本文记录本轮 AUN SDK 重构的实际修改点、测试结果和遗留事项。

## 基线

- 参考设计：`docs/AUN_SDK_重构设计方案_v3.md`（内容版本 v4.0）
- 实施计划：`docs/AUN_SDK_重构实施计划.md`
- 测试指南：`docs/aun测试运行指南.md`
- 2026-05-28 阶段 0：在当前工作区执行 `python -X utf8 -m pytest tests/unit/ -v -s --tb=short`，收集 560 个 Python 单元测试，用例通过。

## 阶段 1：Python 基础类型层

- 状态：已完成
- 目标：新增 `Result` / `AID` / `AIDStore` 离线能力，并通过单元测试覆盖。
- 修改点：
  - 新增 `python/src/aun_core/result.py`：`Result`、`ErrorInfo`、`result_ok`、`result_err`。
  - 新增 `python/src/aun_core/error_codes.py`：阶段 1 所需错误码常量。
  - 新增 `python/src/aun_core/_cert_utils.py`：agent.md 签名块解析/构造、证书指纹、公钥 DER、签名验签纯函数。
  - 新增 `python/src/aun_core/aid.py`：不可变 `AID` 值对象，支持 `is_cert_valid()`、`is_private_key_valid()`、payload 签验和 agent.md 签验。
  - 新增 `python/src/aun_core/aid_store.py`：`AIDStore.load()`、`list()`、`change_seed()` 离线能力，复用现有 `FileKeyStore` 布局。
  - 更新 `python/src/aun_core/__init__.py` 导出 `AIDStore`、`AID`、`Result`、`ErrorInfo`、`result_ok`、`result_err`。
  - 新增 `python/tests/unit/test_result.py`、`test_aid.py`、`test_aid_store_offline.py`。
- 测试：
  - `python -X utf8 -m pytest tests/unit/test_result.py tests/unit/test_aid.py tests/unit/test_aid_store_offline.py -v -s --tb=short`：11 passed。

## 阶段 2：Python AIDStore 联网方法

- 状态：已完成
- 修改点：
  - 更新 `python/src/aun_core/aid_store.py`：
    - 构造时持有 `DnsResilientNet`、`GatewayDiscovery`、`AuthFlow`，复用现有 keystore 和认证流程。
    - 新增 `_resolve_gateway()`，对齐旧 `AuthNamespace` 的 gateway 发现顺序和 keystore metadata 缓存。
    - gateway 内存缓存按 issuer 域隔离，避免单个 `AIDStore` 先解析单域后错误复用到跨域 AID。
    - 新增 `register()`、`exists()`、`resolve()`、`fetch_agent_md()`、`head_agent_md()`、`check_agent_md()`、`diagnose()`。
    - `exists()` 使用与 GET 证书一致的 `/pki/cert/{aid}` URL 做 HEAD 判断，200/404 明确区分已注册/未注册，非 2xx/404 归入 `NETWORK_ERROR`。
    - `fetch_agent_md()` 下载 `https://{aid}/agent.md`，支持 ETag/Last-Modified 条件请求缓存，并使用本地或解析得到的证书验签。
    - 完成 `renew_cert()`：通过 `auth.aid_login1` 获取服务端 nonce，使用现有私钥签名 nonce，调用 `auth.renew_cert`，校验返回证书的 CN/有效期/公钥后保存新证书。
    - 完成 `rekey()`：生成新 keypair，通过旧私钥签名 `nonce + new_public_key`，调用 `auth.rekey`，校验返回证书绑定新公钥后替换本地 keypair 与证书。
    - `renew_cert()` / `rekey()` 增加按 AID 的异步锁，避免同一身份并发续期/换钥导致本地证书和私钥写入竞态。
    - 续期/换钥流程增加 debug/warn 诊断日志，覆盖入口、login1、证书保存、成功退出和失败路径。
  - 新增 `python/tests/unit/test_aid_store_network.py`，用 mock 网络边界覆盖注册、PKI HEAD、远端证书解析、agent.md 下载验签、agent.md HEAD、诊断组合、跨域 gateway 缓存隔离、续期、换钥、私钥缺失和 RPC 异常映射。
  - 更新 `D:/modelunion/kite/extensions/services/gateway/ws_server.py`：现有 `/pki/cert/{aid}` 路由显式支持 HEAD，复用 GET 查询逻辑判定状态码但返回空 body。
- 测试：
  - TDD 失败确认：`python -X utf8 -m pytest tests/unit/test_aid_store_network.py -v -s --tb=short`：2 failed / 9 passed，失败点为 `renew_cert` / `rekey` stub。
  - `python -X utf8 -m pytest tests/unit/test_aid_store_network.py -v -s --tb=short`：11 passed。
  - `python -X utf8 -m pytest tests/unit/test_result.py tests/unit/test_aid.py tests/unit/test_aid_store_offline.py tests/unit/test_aid_store_network.py -v -s --tb=short`：22 passed。
  - `python -X utf8 -m pytest tests/unit/ -v -s --tb=short`：582 passed。
  - `python -m py_compile D:/modelunion/kite/extensions/services/gateway/ws_server.py`：通过。
  - 说明：服务端代码已修改；按 `docs/aun测试运行指南.md`，后续跑 Docker 集成/E2E 前需要重新 build 服务镜像并重启对应容器。

## 阶段 3：Python AUNClient 状态机

- 状态：已完成
- 修改点：
  - 更新 `python/src/aun_core/types.py`：`ConnectionState` 替换为 `no_identity`、`standby`、`authenticated`、`connecting`、`ready`、`retry_backoff`、`reconnecting`、`connection_failed`、`closed` 九态。
  - 更新 `python/src/aun_core/client.py`：
    - 构造函数支持 `AUNClient(AID)`，有有效私钥身份时进入 `standby`，无身份时进入 `no_identity`。
    - 新增 `load_identity()`，允许在 `no_identity` / `closed` 状态加载或重载身份。
    - 新增公开 `authenticate()`，只获取 token，不建立长连接。
    - 重构 `connect()`：`standby` 自动认证；`authenticated`、`retry_backoff`、`connection_failed` 可复用已有 token；手动 connect 可打断退避并立即重连。
    - 重构 `disconnect()`：主动断开后按是否仍有身份回到 `standby` 或 `no_identity`，并清理 token、退避和错误状态。
    - 重构 `close()`：关闭连接并清除身份、token、gateway、会话参数和退避状态，最终进入 `closed`。
    - 新增 capability getter：`current_aid`、`has_identity`、`can_sign`、`can_connect`、`can_send`、`is_ready`、`is_online`、`is_closed`、`aun_path`。
    - 新增重连/错误 getter：`next_retry_at`、`next_retry_in_seconds`、`retry_attempt`、`retry_max_attempts`、`last_error`、`last_error_code`。
    - `state` 对外返回新枚举，同时保留内部旧状态字符串到新状态的映射，降低存量测试迁移风险。
    - `_connect_once()` 成功状态改为 `ready`，`call()` 仅允许 `ready`。
    - `_handle_transport_disconnect()` 区分主动不重连、服务端踢下线、不重连 close code；不可恢复断线进入 `connection_failed` 并记录 `last_error_code`。
    - `_reconnect_loop()` 显式进入 `retry_backoff` / `reconnecting` / `ready` / `connection_failed`，记录下一次重试时间、尝试次数和最终失败原因。
    - 构造级 `protected_headers` 与 `set_protected_headers()` / `get_protected_headers()` 合并到消息类和 thought 类 RPC。
  - 新增 `python/tests/unit/test_client_state_machine.py`，覆盖构造、身份加载、认证、连接、主动断开、关闭后重载、退避重连、失败终态和实例级 `protected_headers`。
  - 迁移旧状态断言测试：
    - `python/tests/unit/test_client.py`
    - `python/tests/unit/test_reconnect.py`
    - `python/tests/unit/test_gateway_disconnect_detail.py`
    - `python/tests/unit/test_py_issues.py`
    - `python/tests/unit/test_p0_common_gaps.py`
- 测试：
  - `python -X utf8 -m pytest tests/unit/test_client_state_machine.py -v -s --tb=short`：10 passed。
  - `python -X utf8 -m pytest tests/unit/ -v -s --tb=short`：592 passed。

## 阶段 4：Python 调用方和测试迁移

- 状态：进行中
- 修改点：
  - 收口 gateway 访问与测试迁移：
    - `AUNClient.gateway_url` 增加只读公开 getter，内部可从已发现并缓存到会话参数的 gateway 读取；半初始化白盒对象使用防御性读取，避免 AttributeError 被重连循环当作可重试异常。
    - `_normalize_connect_params()`、重连健康检查、peer cert 拉取/缓存等内部路径统一通过公开 getter 获取当前 gateway，不要求外部传入或写入 gateway。
    - 清理单测、测试 helper、双域脚本中的 `_gateway_url` 直接赋值，测试需要 gateway 时改为 mock discovery 或使用 SDK 内部会话参数模拟“已发现缓存”。
    - 新增 `has_v2_session` 与 `device_id` 等公开只读能力，用于替换跨域/E2E 对 `_v2_session`、`_device_id` 的直接读取。
    - `python/tests/unit/test_client_strict_api.py` 扩展静态回归，禁止测试/helper/CLI 回退到 `_gateway_url`、双域私有会话字段和 `authenticate({})` 旧写法。
  - 旧 helper 调用迁移：
    - `python/tests/aun_refactor_helpers.py` 与双域 `sdk_client_helper.py` 将 `client.authenticate({})` 改为 `client.authenticate()`。
    - 双域 helper 改用 `AIDStore` 准备身份、`AUNClient.load_identity()` 加载身份、`client.authenticate()` 与 `client.connect()` 完成连接。
  - 更新双域 `e2e_group_invite_code.py`：
    - 连接逻辑统一复用 `sdk_client_helper.ensure_connected()`，避免测试内保留旧认证/连接流程。
    - 移除对本地 `load_all_group_secrets()` 的直接依赖，邀请码入群后改为通过公开 `group.get_members` 等待成员可见。
    - 群消息解密断言从旧 `e2ee.encryption_mode == epoch_group_key` 调整为校验明文文本、发送者和 `encrypted=True`；当前 Python V2 返回的模式为 `v2_P256_HKDF_SHA256_AES_256_GCM`。
    - 临时 pull 诊断确认首轮 `group.pull` 已返回 `raw_count=1` 且 payload 已解密，问题为测试断言不兼容；诊断日志已移除。
  - 2026-05-29 继续清理私有访问和旧接口：
    - 新增 `AUNClient.get_current_v2_group_spk_id(group_id)` 公开诊断接口，E2E 可读取本地当前 group SPK id，但不直接访问 `_v2_session`、`_device_id` 或 keystore 私有字段。
    - `python/tests/e2e_test_slot_id_storm.py` 不再向 `AUNClient` 实例挂载 `_test_slot_id`、`_test_group_inbox`、`_test_undecryptable`，改用测试侧 `WeakKeyDictionary` 保存临时状态；连接参数仍只传 `slot_id` / `auto_reconnect`，gateway 继续由 SDK discovery 链路发现。
    - `python/tests/e2e_test_v2_p2p_e2ee.py` 清理测试类 `self._test_payload` 命名，避免 `_test_*` 扫描噪音。
    - `python/tests/integration_test_p0_common_gaps.py` 移除 `client.check_gateway_health()` 旧 convenience 方法调用，改为测试内 WebSocket `meta.ping` 健康探测；真实 gateway URL 仍通过 `.well-known/aun-gateway` discovery 获取。
    - 双域 `gateway_to_gateway.py` 移除 `client.ping()`，改为 `client.call("meta.ping", {})`。
    - `python/tests/unit/test_client_strict_api.py` 增加静态回归：
      - 非单元测试不得把 `_test_*` 字段挂到 SDK client 上。
      - 非单元测试和双域测试不得调用已删除的 `check_gateway_health()`、`ping()`、`status()`、`trust_roots()` 等 convenience API。
      - `AUNClient` 必须暴露 group SPK 公开诊断 accessor。
- 测试：
  - `python -X utf8 -m pytest python\tests\unit\test_client_strict_api.py -q -s --tb=short`：10 passed。
  - `python -X utf8 -m pytest python\tests\unit\test_client_strict_api.py python\tests\unit\test_client_state_machine.py python\tests\unit\test_client.py -q -s --tb=short -k "..."`：36 passed / 120 deselected。
  - `python -X utf8 -m pytest python\tests\unit\test_client.py -q -s --tb=short -k "test_max_attempts_zero_means_infinite or test_max_attempts_stops_reconnect_on_health_fail"`：2 passed / 135 deselected。
  - `python -X utf8 -m pytest python\tests\unit -q -s --tb=short --maxfail=40 -p no:cacheprovider --basetemp D:\tmp\pytest-aun-unit-refactor7`：602 passed / 18 warnings。
  - 静态扫描：`rg "\._gateway_url|_gateway_url\s*=" python\tests ..\docker-deploy\federation-test\tests python\src\aun_cli` 无结果；`authenticate({})` 仅保留在严格 API 旧写法拒绝测试中。
  - `docker exec client-a python -X utf8 /test/e2e_group_invite_code.py`：3/3 passed。
  - TDD 失败确认：`python -X utf8 -m pytest python\tests\unit\test_client_strict_api.py -q -s --tb=short -k "group_spk_diagnostic or private_test_fields"`：2 failed，失败点为缺少公开 group SPK accessor 和 `e2e_test_slot_id_storm.py` 的 `_test_*` client 字段。
  - 修复后：`python -X utf8 -m pytest python\tests\unit\test_client_strict_api.py -q -s --tb=short -k "group_spk_diagnostic or private_test_fields"`：2 passed / 10 deselected。
  - TDD 失败确认：`python -X utf8 -m pytest python\tests\unit\test_client_strict_api.py -q -s --tb=short -k "removed_client_methods"`：1 failed，失败点为 `integration_test_p0_common_gaps.py` 的 `check_gateway_health()` 和双域 `gateway_to_gateway.py` 的 `ping()`。
  - 修复后：`python -X utf8 -m pytest python\tests\unit\test_client_strict_api.py -q -s --tb=short -k "removed_client_methods"`：1 passed / 12 deselected。
  - `python -X utf8 -m pytest python\tests\unit\test_client_state_machine.py python\tests\unit\test_client_strict_api.py -q -s --tb=short`：24 passed。
  - `python -X utf8 -m py_compile python\tests\integration_test_p0_common_gaps.py python\tests\e2e_test_slot_id_storm.py python\tests\e2e_test_v2_p2p_e2ee.py ..\docker-deploy\federation-test\tests\gateway_to_gateway.py`：通过。
  - `python -X utf8 -m pytest python\tests\unit -q -s --tb=short --maxfail=40 -p no:cacheprovider --basetemp D:\tmp\pytest-aun-unit-refactor8`：606 passed / 18 warnings。
  - 静态扫描：`rg "\._(device_id|v2_session|transport|dispatcher|identity|slot_id|seq_tracker|v2_bootstrap_cache|v2_build_target|gateway_url)" python\tests ..\docker-deploy\federation-test\tests -g "*.py" -g "!python/tests/unit/**"` 无结果；`rg "\._test_[A-Za-z0-9_]+" python\tests ..\docker-deploy\federation-test\tests -g "*.py"` 无结果；旧 convenience API 调用扫描无结果。

## 阶段 5：竞态修复与并发安全

- 状态：已完成
- 目标：修复审查发现的 6 个竞态问题，确保消息投递有序、状态一致。
- 修改点：
  - 更新 `python/src/aun_core/client.py`：
    - 新增 `_ns_locks: dict[str, asyncio.Lock]` 和 `_get_ns_lock(ns)` 辅助方法。
    - P2P push 处理 `_process_and_publish_message` 拆分为外层加锁 + `_process_and_publish_message_inner`，同一 `p2p:{aid}` namespace 串行。
    - P2P gap fill `_fill_p2p_gap` 拆分为外层加锁 + `_fill_p2p_gap_inner`，与 push 共享同一 ns lock。
    - 群消息 push `_on_raw_group_message_created` 拆分为外层加锁 + `_on_raw_group_message_created_inner`，同一 `group:{group_id}` namespace 串行。
    - V2 群消息 push `_on_raw_group_v2_message_created` 内的 `_pull_and_publish` 闭包在 ns lock 保护下执行。
    - `_on_raw_group_message_created_inner` 内的 V2 pull 闭包同样在 ns lock 保护下执行。
    - 群事件 gap fill `_fill_group_event_gap` 拆分为外层加锁 + `_fill_group_event_gap_inner`，使用 `group_event:{group_id}` ns lock。
    - **锁设计原则**：锁只在最外层入口获取，内部方法不获取锁；`create_task` 出去的独立 task 自行获取锁（此时外层已释放）；不同 namespace 互不阻塞，无交叉等待，不会死锁。
    - Token refresh loop：刷新成功后检查 `_public_state != ConnectionState.READY` 才丢弃结果，防止断线期间写回 stale identity。
    - Token refresh exhausted：不再调用 `_handle_transport_disconnect`（会 cancel 自身），改为直接 `transport.close()` 让 on_disconnect 回调自然触发重连。
    - Reconnect loop：每个关键 await 点（sleep、publish、health check、transport.close、connect_once）后检查 `self._closing`，及时退出。
  - 更新 `python/src/aun_core/events.py`：
    - `EventDispatcher.publish` 从 `asyncio.gather` 并发执行改为 `for` 循环顺序执行 handler，防止同一事件的多个 handler 并发交错修改共享状态。
- 跨语言对齐要点：
  - 所有 SDK 的消息 push/pull 处理必须在同一 namespace 内串行（Go 用 mutex/channel，TS/JS 用 promise chain 或 mutex 库）。
  - EventDispatcher/EventEmitter 的 handler 调用必须顺序执行，不可并发。
  - Token refresh 成功后必须检查连接状态是否仍然有效再写回。
  - Reconnect loop 内部每个异步等待点后必须检查 closing 标志。
- 测试：
  - `python -X utf8 -m pytest tests/unit/ -q --tb=short`：623 passed。

## 阶段 6：Keystore 加密策略简化

- 状态：已完成
- 目标：SQLite 数据库中除 IK 私钥外的所有字段改为明文存储，读取时兼容旧密文。
- 修改点：
  - 更新 `python/src/aun_core/keystore/sqlite_db.py`：
    - `save_prekey`：`private_key_enc` 字段写入明文（SPK 是临时密钥，无需加密）。
    - `save_group_current`：`secret_enc` 字段写入明文。
    - `save_group_old_epoch`：`secret_enc` 字段写入明文。
    - `_upsert_group_current`：`secret_enc` 字段写入明文。
    - `_upsert_group_old_epoch`：`secret_enc` 字段写入明文。
    - `save_session`：`data_enc` 字段写入明文。
    - `_protect_text` 方法保留但不再有调用点（供未来需要时使用）。
    - `_reveal_text` 读取时自动检测：如果是 `{"scheme":"file_aes",...}` 格式则解密（兼容旧数据），否则直接返回明文。
  - IK 私钥加密保持不变（`keystore/file.py` 中 `_protect_field` → `key.json` 的 `private_key_protection`）。
- 加密策略总结：

  | 字段 | 存储位置 | 写入 | 读取 |
  |------|----------|------|------|
  | IK 私钥 | `file.py` → `key.json` | `_protect_field` 加密 | `_reveal_field` 解密 |
  | SPK/prekey 私钥 | `sqlite_db` → `prekeys.private_key_enc` | 明文 | `_reveal_text` 兼容明文/密文 |
  | 群密钥 secret | `sqlite_db` → `group_current/old_epochs.secret_enc` | 明文 | `_reveal_text` 兼容明文/密文 |
  | e2ee session | `sqlite_db` → `e2ee_sessions.data_enc` | 明文 | `_reveal_text` 兼容明文/密文 |

- 跨语言对齐要点：
  - TS/Go 的 SQLite 存储层同样需要移除 prekey/group secret/session 的加密写入，保留读取兼容。
  - 只有 IK（AID 长期私钥）需要加密保护，SPK 是临时密钥无需加密。
- 测试：
  - `python -X utf8 -m pytest tests/unit/test_keystore.py -v --tb=short`：52 passed。
  - `python -X utf8 -m pytest tests/unit/ -q --tb=short`：623 passed。

## 阶段 7：Seed 迁移安全重构

- 状态：已完成
- 目标：`seed_migration.py` 增强安全性，防止迁移过程中 key.json 变成无效状态。
- 修改点：
  - 更新 `python/src/aun_core/keystore/seed_migration.py`：
    - `migrate_seed_materials` 重写为三阶段验证：
      1. 读取 `.seed` 文件，验证 `.seed` 能否解密现有私钥。
      2. 若 `.seed` 解不开：检查 `seed_password` 能否解密；若能则归档残留 `.seed`；若都不能则报明确错误。
      3. 若 `.seed` 能解密：执行 `_change_seed_bytes` 迁移到 `seed_password`，失败时 fallback 继续用 `.seed`。
    - 新增 `_can_decrypt_any_private_key(root, master_key)` 验证函数。
    - 新增 `_has_encrypted_private_keys(root)` 检测是否存在加密数据。
    - 新增 `_rename_seed_file(seed_path)` 安全归档。
    - 错误消息明确指出失败原因和修复建议。
- 跨语言对齐要点：
  - 所有 SDK 的 seed 迁移必须遵循"先验证能解密再迁移"原则。
  - 迁移失败时必须 fallback 到旧 seed（保证能解密），绝不能让 key.json 变成无法解密状态。
  - `.seed` 无法解密且 `seed_password` 也无法解密时，必须报明确错误而非静默 fallback。
- 测试：
  - `python -X utf8 -m pytest tests/unit/test_keystore.py -v --tb=short`：52 passed。

## 阶段 8：Namespace 模块删除

- 状态：已完成
- 目标：移除旧的 namespace 抽象层，功能已由 `AIDStore` + `AUNClient` 直接承载。
- 修改点：
  - 删除 `python/src/aun_core/namespaces/__init__.py`。
  - 删除 `python/src/aun_core/namespaces/auth_namespace.py`（855 行）：注册/登录/证书管理功能已迁移到 `AIDStore.register()` + `AuthFlow`。
  - 删除 `python/src/aun_core/namespaces/custody_namespace.py`（364 行）：密钥托管功能已迁移到 `AIDStore.change_seed()` + `keystore/seed_migration.py`。
  - 删除 `python/src/aun_core/namespaces/meta_namespace.py`（544 行）：元数据/诊断功能已迁移到 `AUNClient.call("meta.*")` 直接 RPC + `AIDStore.diagnose()`。
- 跨语言对齐要点：
  - 其他 SDK 如有类似的 namespace 抽象层（AuthNamespace/CustodyNamespace/MetaNamespace），可直接删除。
  - 注册走 `AIDStore.register()`，认证走 `AuthFlow.authenticate()`，连接走 `AUNClient.connect()`。
  - meta.* 方法通过 `client.call("meta.xxx", params)` 直接调用，无需 namespace 包装。

## 阶段 9：V2 跨域 peer cert 与 state 兼容修复

- 状态：进行中
- 修改点：
  - 更新 `python/src/aun_core/client.py`：
    - V2 peer cert 下载改为按 peer AID issuer 做内部 gateway discovery；本域 peer 复用当前已发现 gateway，跨域 peer 才发现并缓存对端 issuer gateway。
    - `_fetch_peer_cert()` 和 `_validate_and_cache_peer_cert()` 统一使用 peer gateway URL 下载/验证证书，删除基于本地 gateway 主机名字符串替换的跨域路由逻辑。
    - peer gateway 缓存按 issuer 隔离，并在身份运行时重建和 `close()` 时清理，避免跨身份污染。
    - `V2 committed state base snapshot is not object` 的根因确认：历史群 state commit 的 `membership_snapshot` 存在 legacy JSON 数组格式（如 `["alice.aid.com","bobb.aid.net"]`），新 V2 commitment 要求对象格式。客户端现在对 legacy 数组只作为已提交 `prev_state_hash` 锚点接受，不再阻塞后续新格式 state proposal；非数组/非对象仍按异常告警。
  - 更新 `python/tests/unit/test_client.py`：
    - 迁移 peer cert 超时测试到重构后的有身份客户端语义，不再构造无身份客户端并手工塞 gateway。
  - 更新 `../docker-deploy/federation-test/tests/sdk_client_helper.py`：
    - 双域测试 helper 在 `AUN_VERIFY_SSL` 未开启时设置 `AUN_ENV=development`，确保新构造链路按开发环境关闭 TLS 校验。
- 测试：
  - `python -X utf8 -m py_compile python\src\aun_core\client.py ..\docker-deploy\federation-test\tests\sdk_client_helper.py`：通过。
  - `python -X utf8 -m pytest python\tests\unit\test_client_strict_api.py python\tests\unit\test_client.py::test_fetch_peer_cert_uses_explicit_timeout python\tests\unit\test_client.py::test_fetch_peer_cert_net_path_does_not_reference_removed_response -q -s --tb=short`：19 passed。
  - `docker exec client-a python -X utf8 /test/e2e_v2_cross_domain.py`：10 passed / 0 failed。

## 跨语言同步

- 状态：进行中
- 修改点：
  - TypeScript SDK：
    - 新增并导出 `AID`、`AIDStore`、`Result`、`ErrorInfo`、`resultOk`、`resultErr`。
    - `AUNClient` 构造入口收紧为 `new AUNClient(options?)` 或 `new AUNClient(aid: AID, options?)`；`aid` 必须是 `AID` 对象，拒绝字符串 AID、`options.aid` 和第二参数 boolean debug。
    - `AUNClient` 增加 `currentAid`、`hasIdentity`、`canSign`、`canConnect`、`canSend`、`isReady`、`isOnline`、`isClosed`、`aunPath`、`nextRetryAt`、`nextRetryInSeconds`、`retryAttempt`、`lastError`、`lastErrorCode`。
    - `AUNClient.loadIdentity(aid)` 支持在 `no_identity` / `closed` 状态加载身份并进入 `standby`。
    - `setProtectedHeaders()` / `getProtectedHeaders()` 与构造级 `protected_headers` 已支持，并只合并到 `message.send`、`group.send`、`message.thought.put`、`group.thought.put`。
    - `ConnectionState` 改为运行时导出，入口可直接 `import { ConnectionState }`。
    - 新增 `ts/tests/unit/aid-store-refactor.test.ts` 锁定三主体 API、AID agent.md 签验、client capability 和 protected_headers 合并。
  - Go SDK：
    - 新增 `AID`、`AIDStore`、错误码常量和 client 状态机单测。
    - `NewAUNClient` 构造入口收紧为 options-only 或 `*AID + options`；字符串 AID 和 `options.Raw["aid"]` 运行时拒绝，`NewAUNClientEmpty` 仅作为无身份包装入口。
    - 修复 `AID.SignAgentMd()` 签名块拼接：签名块不再额外前置空行，避免 `VerifyAgentMd()` 取出的 payload 与签名输入不一致。
    - 新增/通过 `go/aid_store_test.go`、`go/client_state_machine_test.go` 覆盖 AIDStore 离线加载、AID 签验、agent.md 签验、AUNClient capability。
  - JavaScript 浏览器 SDK：
    - 新增 `js/src/cert-utils.ts`、`js/src/aid.ts`、`js/src/aid-store.ts`，实现异步版 AID/AIDStore 离线层。
    - `ConnectionState` 改为运行时 enum 风格导出，并提供旧内部状态到新九态的映射。
    - `AUNClient` 构造入口收紧为 `new AUNClient(options?)` 或 `new AUNClient(aid: AID, options?)`；`aid` 必须是 `AID` 对象，拒绝字符串 AID、`options.aid` 和第二参数 boolean debug。
    - `AUNClient` 增加 `loadIdentity()`、capability getter 和 `setProtectedHeaders()` / `getProtectedHeaders()`。
    - protected_headers 合并范围与 Python/TS 保持一致，只覆盖消息类和 thought 类 RPC。
    - 新增 `js/tests/unit/aid-store-refactor.test.ts`，用 fake-indexeddb 覆盖 AID/AIDStore/AUNClient 离线三主体。
- 测试：
  - `cd ts && npm run build`：通过。
  - `cd ts && npx vitest run tests/unit/aid-store-refactor.test.ts --reporter=verbose`：4 passed。
  - `cd go && go test ./... -run 'TestAIDStore|TestAID|TestNewAUNClient|TestLoadIdentity|TestConnectionState|TestClientGetters' -count=1 -v`：通过。
  - `cd js && npm run build`：通过。
  - `cd js && npx vitest run --environment jsdom tests/unit/aid-store-refactor.test.ts --reporter=verbose`：3 passed。
  - `cd ts && npm run test:unit -- --reporter=verbose`：通过。
  - `cd ts && npm run build`：通过。
  - `cd go && go test ./... -count=1 -v`：通过。
  - `cd js && npm run build`：通过。
  - `cd js && npm run test:unit -- --reporter=verbose`：28 files / 401 tests passed。
- 2026-05-29 继续同步修复：
  - TypeScript SDK：
    - `connection.state` 事件 payload 改为对外九态，内部旧状态通过映射转换，避免事件继续泄漏 `idle` / `connected` / `disconnected` / `terminal_failed` 等旧值。
    - 旧状态断言测试迁移到 `no_identity` / `standby` / `ready` / `connection_failed`。
  - JavaScript 浏览器 SDK：
    - `connection.state` 事件 payload 同步改为对外九态。
    - 旧状态断言测试迁移到 `no_identity` / `standby` / `ready` / `connection_failed`。
    - `client-v2-only-parity.test.ts` 中 `pullV2` 断言对齐实现传参 `{ force: false }`。
    - `cacheStateSignature()` 测试改为 length-prefixed bytes framing，与实现中的缓存签名一致。
    - `token-gateway-reuse.test.ts` 补齐身份 fixture 的 `public_key_der_b64`、`curve`，并 mock 非 cached-token 分支的 `_assertCertMatchesLocalKeypair()`，让单测聚焦 token 复用行为。
  - Go SDK：
    - 全包单测复跑通过，确认 AID/AIDStore 和状态机前置同步改动没有回归。
  - 构造入口收紧：
    - TypeScript/JavaScript 新增构造约束测试：options-only 构造可用；`AID + options` 构造可用；字符串 AID、`options.aid`、第二参数 boolean debug 均被拒绝。
    - Go 新增构造约束测试：options-only 构造可用；字符串 AID、`Raw["aid"]` 均被拒绝。
    - 迁移 TS/JS/Go 内部调用点：`debug` 统一进入 options；跨 SDK agent 不再调用旧的 `(config, debug)` 构造形式。
  - 本轮本地回归：
    - `cd ts && npm run build`：通过。
    - `cd ts && npm run test:unit -- --reporter=verbose`：通过。
    - `cd js && npm run build`：通过。
    - `cd js && npm run test:unit -- --reporter=verbose`：28 files / 401 tests passed。
    - `cd go && go test ./... -count=1 -v`：通过。
  - 本轮 Docker 单域回归：
    - `docker exec kite-ts-tester bash -lc 'cd /workspace/ts && files=$(find tests/integration -maxdepth 1 -name "*.test.ts" ! -name "federation*.test.ts" ! -name "reconnect.test.ts" | sort | tr "\n" " "); npx vitest run $files --reporter=verbose --no-file-parallelism --maxWorkers=1'`：通过。
    - `docker exec kite-ts-tester bash -lc 'cd /workspace/ts && npx vitest run tests/e2e/*.test.ts --reporter=verbose --no-file-parallelism --maxWorkers=1'`：4 files / 21 tests passed。
- 2026-05-29 Go 多设备离线补拉修复：
  - Go SDK：
    - `connectOnce()` 调整为先完成 `InitV2Session()`，再触发 post-connect `fillP2pGap()`，避免 V2 设备副本被旧 `message.pull` 路径提前 `message.ack`。
    - `PullV2()` / `PullGroupV2()` 移除解密循环前的 `first_seq` 强制推进，避免 `message.undecryptable` / `group.message_undecryptable` 发布前污染 contiguous 下界。
    - `TestIntegrationMultiDeviceOfflinePull` 在重连前订阅离线设备 push，未收到自动补拉事件时再显式 pull 兜底，覆盖同步/异步时序。
    - 新增 `TestV2P2PPullPublishesUndecryptableBeforeContiguousAdvance`，锁定 V2 pull 解密失败事件发布前不能提前推进 contiguous。
  - 本轮 Go 回归：
    - `cd go && go test ./... -run TestV2P2PPullPublishesUndecryptableBeforeContiguousAdvance -count=1 -v`：先失败后修复通过。
    - `docker exec kite-go-tester sh -lc 'cd /workspace/go && GOCACHE=/workspace/go/.codex_gocache_linux GOTMPDIR=/workspace/go/.codex_gotmp_linux /usr/local/go/bin/go test -tags integration . -run TestIntegrationMultiDeviceOfflinePull -count=1 -v'`：通过。
    - `cd go && go test ./... -count=1 -v`：通过。
    - `docker exec kite-go-tester sh -lc 'cd /workspace/go && GOCACHE=/workspace/go/.codex_gocache_linux GOTMPDIR=/workspace/go/.codex_gotmp_linux /usr/local/go/bin/go test -tags integration . -run Integration -count=1 -v'`：通过。
    - `docker exec kite-go-tester sh -lc 'cd /workspace/go && GOCACHE=/workspace/go/.codex_gocache_linux GOTMPDIR=/workspace/go/.codex_gotmp_linux /usr/local/go/bin/go test -tags integration . -run GroupE2E -count=1 -v'`：通过。
    - `docker exec go-tester sh -lc 'cd /workspace/go && GOCACHE=/workspace/go/.codex_gocache_linux GOTMPDIR=/workspace/go/.codex_gotmp_linux /usr/local/go/bin/go test -tags integration . -run Federation -count=1 -v'`：通过（`FederationReconnect` 未设置 marker，按预期跳过）。
    - PowerShell marker 协调 `docker restart federation-kite-b` 后执行 `docker exec go-tester sh -lc 'cd /workspace/go && AUN_RECONNECT_MARKER=/workspace/go/.codex_fed_reconnect_marker_go GOCACHE=/workspace/go/.codex_gocache_linux GOTMPDIR=/workspace/go/.codex_gotmp_linux /usr/local/go/bin/go test -tags integration . -run TestFederationReconnectAfterRemoteGatewayRestart -count=1 -v'`：通过。
  - 本轮 TypeScript 双域回归：
    - `docker exec ts-tester bash -lc 'cd /workspace/ts && npx vitest run tests/integration/federation.test.ts tests/integration/federation-storage.test.ts --reporter=verbose --no-file-parallelism --maxWorkers=1'`：2 files / 5 tests passed。
    - PowerShell marker 协调 `docker restart federation-kite-b` 后执行 `docker exec ts-tester bash -lc 'cd /workspace/ts && AUN_RECONNECT_MARKER=/workspace/ts/.codex_fed_reconnect_marker_ts npx vitest run tests/integration/federation-reconnect.test.ts'`：1 test passed。
  - 本轮 JavaScript 本地回归：
    - `cd js && npm run build`：通过。
    - `cd js && npm run test:unit -- --reporter=verbose`：28 files / 401 tests passed。
  - 本轮 JavaScript 浏览器 E2E：
    - TDD 失败确认：`cd js && npm run test:e2e`：13 failed，统一失败点为浏览器 E2E helper 仍使用旧构造 `new AUN.AUNClient(config, true)`。
    - 修复 `js/tests/e2e-browser/*.spec.ts` 中旧构造调用，将调试开关统一迁移为 `debug: true` options 字段，符合 `AUNClient(options?)` / `AUNClient(AID, options?)` 构造约束。
    - 静态扫描 `rg "new\s+AUNClient\([^\n]*,\s*true\)|new\s+AUN\.AUNClient\([^\n]*,\s*true\)|\},\s*true\);" js/tests/e2e-browser js/tests/unit js/tests/integration js/src -g "*.ts"`：浏览器 E2E 无旧构造残留；单元测试剩余命中为内部 `_connectOnce(..., true)` 白盒调用，不属于构造入口。
    - `cd js && npm run test:e2e`：13 passed。
  - 本轮 JavaScript integration：
    - TDD 失败确认：`cd js && npm run test:integration -- --reporter=verbose`：17 failed，统一失败点为 integration 测试仍断言旧公开状态 `connected` / `disconnected` / `terminal_failed`。
    - 迁移 `js/tests/integration` 的公开状态断言与 `connection.state` 事件期望到九态语义：`connected` → `ready`、断线事件 `disconnected` → `standby`、终态 `terminal_failed` → `connection_failed`；内部白盒 `_state = 'connected'` 保持不变。
    - `cd js && npm run test:integration -- --reporter=verbose`：10 files / 36 tests passed。
- 2026-05-29 跨 SDK 单域容器 E2E 修复：
  - Python cross-sdk test-control agent：
    - `tests/cross-sdk/python/test_agent.py` 从旧 `AUNClient(config, debug=...)` 迁移到 `AIDStore.load/register/load` + `AUNClient(debug=...)` + `client.load_identity(AID对象)` + `client.connect(options)`。
    - `health()` 改为读取公开 `client.state` 并归一化，`agent_ready` 接受新状态 `ready`，兼容旧状态 `connected`。
  - 跨 SDK runner：
    - TDD 失败确认：E2EE 用例均报 `E2EE envelope metadata missing or invalid`，实际 inbox 已包含规范字段 `protected_headers.sdk_version`。
    - 修复 `tests/cross-sdk/runner/run_cross_sdk_e2e.py` 断言中的字段拼写，将错误的 `sdk_vesion` 改为设计文档规定的 `sdk_version`。
  - TS/Go cross-sdk test-control agent：
    - `ts/src/tools/cross-sdk-agent.ts` 的 `/health` 改为优先读取公开 `client.state`，不再对外暴露内部 `_state=connected`。
    - `go/cmd/cross-sdk-agent/main.go` 的 `/health` 改为读取 `client.ConnectionState()`，对外返回 `ready`，并兼容旧 `connected` 判断。
  - 本轮跨 SDK 回归：
    - `python -m py_compile tests\cross-sdk\python\test_agent.py`：通过。
    - `python -m py_compile tests\cross-sdk\runner\run_cross_sdk_e2e.py`：通过。
    - `cd ts && npm run build`：通过。
    - `cd go && go test ./cmd/cross-sdk-agent -count=1 -v`：通过。
    - `docker compose -f tests/cross-sdk/docker-compose.cross-sdk.yml up --abort-on-container-exit --exit-code-from cross-sdk-runner`：首次暴露 ready 状态适配问题，修复后再次暴露 `sdk_version` 断言拼写问题；最终复跑通过，`69 passed, 0 failed`，`cross-sdk-runner` 退出码为 0。
    - TS/Go health 对外状态复核：`tests/cross-sdk/artifacts/results.json` 中 Python/TS/Go 均为 `state=ready`；C++ 仍为本轮未重构的 `connected`。
    - 旧构造入口静态扫描：TS/JS 未发现 `new AUNClient(..., true|false)`、`new AUN.AUNClient(..., true|false)` 或 `options.aid` 残留；Go 仅剩 `go/client_state_machine_test.go` 中用于拒绝字符串 AID/`Raw["aid"]` 的负向测试命中。
- 2026-05-30 Go SDK 旧 namespace 暴露与 integration 迁移收口：
  - Go SDK：
    - `AUNClient` 不再公开 `Auth` / `Custody` / `Meta` 字段，内部保留 `authNamespace` / `custodyNamespace` / `metaNamespace` 仅供尚未下沉的实现复用。
    - 新增/完善 `ConnectOptions` 的 `GatewayURL`、`SlotID`、`DeliveryMode`、`QueueRouting`、`AffinityTtlMs`、`BackgroundSync` 等字段，支持新 `Connect(ctx, opts?)` 调用链。
    - 删除 `Connect(ctx, authMap, opts)` 公开兼容分支；公开入口现在只接受 `Connect(ctx)`、`Connect(ctx, *ConnectOptions)`、`Connect(ctx, ConnectOptions)` 或 `nil`，白盒测试通过内部 helper 触达底层连接参数。
    - 新增 `AUNClient.Authenticate(ctx, opts?)`，基于已加载的 `*AID` 完成认证并缓存 token，不建立长连接。
    - `connectWithLoadedIdentity()` 统一使用当前 `*AID` + discovery/cached gateway，调用方不再传 `authResult`。
    - `ConnectionState()` 根据是否已认证映射 `authenticated` 九态；`Disconnect()` / `Close()` / `LoadIdentityFromAID()` 同步清理认证状态。
    - `AIDStore` 增加 `SetGatewayURL()`，`HeadAgentMD()` 等联网方法改用内部 namespace 字段。
    - `go/cmd/cross-sdk-agent/main.go` 迁移为 `AIDStore.Register/Load` + `LoadIdentity(AID对象)` + `Connect(options)`，健康检查读取 `ConnectionState()`。
  - Go integration 测试：
    - 新增 `go/integration_refactor_helpers_test.go`，统一封装 `AIDStore.Register/Load`、`LoadIdentity()`、`Authenticate()`、`Connect()`。
    - 单元测试中的旧公开 `Connect(..., map[string]any{...})` 调用迁移到 `connectWithTestAuth()`，保留底层连接参数覆盖，同时不再依赖公开旧签名。
    - 迁移 `federation_test.go`、`federation_reconnect_test.go`、`integration_test.go`、`integration_e2e_v2_test.go`、`integration_echo_test.go`、`integration_extra_info_test.go`、`integration_gateway_quota_test.go`、`integration_long_short_test.go`、`integration_reconnect_test.go`。
    - 继续迁移 `integration_p2p_failure_paths_test.go`、`integration_token_refresh_test.go`、`integration_token_gateway_reuse_test.go`、`p0_integration_test.go`，移除公开 `client.Auth.*`、`client.Connect(authResult, opts)` 旧调用。
    - Token/gateway 复用测试保留原行为断言，改用 `client.Authenticate()` 读取返回 token，并通过 `LoadIdentity(AID对象)` 进入新链路。
    - 重连类测试改为断线后直接 `Connect(ctx)`，由 SDK 使用已加载 AID 自动认证。
  - 本轮 Go 回归：
    - 静态扫描 `rg "Auth\.CreateAID|Auth\.RegisterAID|Auth\.Authenticate|Connect\([^\n]*auth|Connect\([^\n]*authResult|\.Auth\." -g "*.go" go`：无旧调用残留。
    - 删除公开 `Connect(authMap)` 兼容分支后，静态扫描 `rg "Connect\([^\n]*map\[string\]any|connectWithAuth|legacy Connect|Auth\.CreateAID|Auth\.RegisterAID|Auth\.Authenticate|\.Auth\." -g "*.go" go`：仅命中 `go/transport.go` 的底层 `RPCTransport.Connect(ctx, url)`，不属于 AUNClient 旧 API。
    - `cd go && go test -tags integration . -run '^$' -count=1 -v`：通过，integration 包编译无旧 API 迁移红灯。
    - `cd go && go test ./... -count=1 -v`：通过。
    - `docs/aun测试运行指南.md` 已在每轮测试结束后重新读取；本轮未启动 Docker 集成/E2E/跨域链路。
- 2026-05-30 Go SDK 旧公开便利方法收口：
  - Go SDK：
    - 新增 `TestAUNClientStrictPublicAPIRemovedLegacyMethods`，通过反射守卫 `AUNClient` 不再暴露 `FetchAgentMD` / `CheckAgentMD` / `SetAgentMDPath` / `ListIdentities` / `CheckGatewayHealth` / `Ping` / `Status` / `TrustRoots` / `LoadIdentityFromAID` 等旧公开方法。
    - `AUNClient.FetchAgentMD()` / `CheckAgentMD()` 降为包内 `fetchAgentMD()` / `checkAgentMD()`，运行时缓存、RPC meta 自动补拉和白盒单测继续复用内部方法；公开下载/检查入口保留在 `AIDStore.FetchAgentMD()` / `AIDStore.CheckAgentMD()`。
    - `AUNClient.SetAgentMDPath()`、`CheckGatewayHealth()`、`ListIdentities()`、`Ping()`、`Status()`、`TrustRoots()`、`LoadIdentityFromAID()` 降为包内方法或通过 `LoadIdentity()` / `Call("meta.*")` / `AIDStore` 新入口替代。
    - `p0_common_gaps_test.go`、`p0_integration_test.go`、`client_agent_md_api_test.go`、`client_state_machine_test.go` 同步迁移，不再依赖旧公开方法集。
    - V2 P2P/Group 解密失败路径改为通过 `publishAppEventSync()` 同步发布 `message.undecryptable` / `group.message_undecryptable`，保证错误事件在 `contiguous_seq` 推进前可见，并复用统一事件 payload 归一化逻辑。
  - 本轮 Go 回归：
    - TDD 失败确认：`cd go && go test ./... -run TestAUNClientStrictPublicAPIRemovedLegacyMethods -count=1 -v` 首次失败，失败点为 `AUNClient` 仍暴露 `FetchAgentMD`。
    - 修复后：`cd go && go test ./... -run TestAUNClientStrictPublicAPIRemovedLegacyMethods -count=1 -v`：通过。
    - `cd go && go test ./... -run 'TestAgentMDPathDefaultAndSet|TestFetchAgentMD|TestCheckAgentMD|TestLoadIdentity|TestConnectNewAPI' -count=1 -v`：通过。
    - `cd go && go test ./... -count=1 -v`：通过。
    - 静态扫描 `rg "func \(c \*AUNClient\) (FetchAgentMD|CheckAgentMD|CheckAgentMd|SetAgentMDPath|SetAgentMdPath|ListIdentities|CheckGatewayHealth|Ping|Status|TrustRoots|LoadIdentityFromAID)\(" go/client.go`：无命中。
    - 静态扫描旧公开调用只剩 `AIDStore` 新归属方法、keystore 内部接口和 `go/namespace` 包自身单测命中；不再有 `AUNClient` 旧公开方法调用。
    - TDD 失败确认：Docker Go E2E 补跑更准正则 `Test(LongShortE2E|V2(P2P|Group|MultiDevice))` 时额外命中本地契约测试 `TestV2P2PPullPublishesUndecryptableBeforeContiguousAdvance`，失败点为 undecryptable handler 观察到 `contiguous_seq` 已提前推进到 1。
    - 修复后：`cd go && go test ./... -run TestV2P2PPullPublishesUndecryptableBeforeContiguousAdvance -count=1 -v`：通过；`cd go && go test ./... -count=1 -v`：通过。
    - Docker 单域 integration：`docker exec kite-go-tester sh -lc "mkdir -p /workspace/go/.codex_gocache_linux /workspace/go/.codex_gotmp_linux && cd /workspace/go && GOCACHE=/workspace/go/.codex_gocache_linux GOTMPDIR=/workspace/go/.codex_gotmp_linux /usr/local/go/bin/go test -tags integration . -run Integration -count=1 -v"`：通过。
    - Docker 单域 E2E：先按指南执行 `-run GroupE2E`，仅命中 `TestClientGroupE2EEAlwaysEnabled` 且通过；随后按实际 Go E2E 命名补跑 `TestLongShortE2E_*` 与 `TestV2P2P*` / `TestV2Group*` / `TestV2MultiDeviceSelfSync` 精确集合：通过。
    - Docker 双域 federation 普通用例：`docker exec go-tester sh -lc "mkdir -p /workspace/go/.codex_gocache_linux /workspace/go/.codex_gotmp_linux && cd /workspace/go && GOCACHE=/workspace/go/.codex_gocache_linux GOTMPDIR=/workspace/go/.codex_gotmp_linux /usr/local/go/bin/go test -tags integration . -run Federation -count=1 -v"`：通过；`FederationReconnect` 子用例因未设置 marker 按预期跳过。
    - Docker 双域 federation reconnect：PowerShell marker 协调 `docker restart federation-kite-b` 后执行 `docker exec go-tester sh -lc "cd /workspace/go && AUN_RECONNECT_MARKER=/workspace/go/.codex_fed_reconnect_marker_go ... go test -tags integration . -run FederationReconnect -count=1 -v"`：通过，客户端在远端域重启后第 1 次重连成功。
    - `docs/aun测试运行指南.md` 已在每轮测试结束后重新读取；Go Docker integration/E2E/双域跨域链路已串行复测完成。
- 2026-05-30 TypeScript SDK 内部 namespace 清理：
  - TS SDK：
    - 删除 `ts/src/namespaces/auth.ts`、`ts/src/namespaces/custody.ts`、`ts/src/namespaces/meta.ts`，并移除空的 `ts/src/namespaces` 目录。
    - `AUNClient` 内部移除 `_authNamespace` 适配器，不再 import、构造或通过旧 `AuthNamespace` 完成 agent.md 上传/下载/HEAD/验签。
    - 将 agent.md HTTP PUT/GET/HEAD、上传 token 获取、远端证书加载、下载 singleflight、全局下载并发上限和 `AID.verifyAgentMd()` 验签下沉为 `AUNClient` 私有方法。
    - `publishAgentMd()` 改为直接使用当前 `AID` 对象 `signAgentMd()` 签名，再调用 client 内部上传方法。
    - `_fetchAgentMdOnce()`、`_agentMdAuthCacheMeta()`、`_checkAgentMdCache()` 改为直接使用 client 自身 agent.md 私有方法和缓存，不再读取旧 namespace 状态。
  - TS 测试：
    - `client-agent-md-api.test.ts`、`client.test.ts` 的白盒 spy 从旧 `_authNamespace.*` 迁移到 `_uploadAgentMd` / `_downloadAgentMd` / `_verifyAgentMd` / `_headAgentMd`。
    - `auth-namespace.test.ts` 改为 `AUNClient agent.md internals`，签名类测试改用 `AID.signAgentMd()`，验签改用 client 内部 `_verifyAgentMd()`。
    - `meta-namespace.test.ts` 改为公开 API 移除守卫，确认包入口和 `AUNClient` 不再暴露旧 `MetaNamespace` / `meta`。
    - `p0-common-gaps.test.ts`、`token-gateway-reuse.test.ts`、`tests/test-support.ts` 迁移旧 namespace 白盒调用到新内部方法或 keystore metadata 断言。
  - 本轮 TS 回归：
    - `cd ts && npm run build`：通过。
    - `cd ts && npx vitest run tests/unit/auth-namespace.test.ts tests/unit/client-agent-md-api.test.ts tests/unit/client.test.ts tests/unit/meta-namespace.test.ts tests/unit/p0-common-gaps.test.ts tests/unit/token-gateway-reuse.test.ts --reporter=verbose`：6 files / 190 tests passed。
    - `cd ts && npm run test:unit -- --reporter=verbose`：通过。
    - 静态扫描 `rg "_authNamespace|AuthNamespace|CustodyNamespace|MetaNamespace|from ['\\\"].*namespaces|\\.auth\\.|\\.meta\\.|\\.custody\\." ts/src ts/tests`：无旧 namespace 调用残留。
    - `docs/aun测试运行指南.md` 已在 build/单测结束后重新读取。
- 2026-05-30 JavaScript SDK 内部 namespace 清理：
  - JS SDK：
    - `AUNClient` 内部移除 `_authNamespace` 适配器，不再 import、构造或通过旧 `AuthNamespace` 完成 agent.md 上传/下载/HEAD/验签。
    - 将 agent.md HTTP PUT/GET/HEAD、上传 token 获取、远端证书加载和 `AID.verifyAgentMd()` 验签下沉为 `AUNClient` 私有方法。
    - `publishAgentMd()` 改为直接使用当前 `AID` 对象 `signAgentMd()` 签名，再调用 client 内部上传方法。
    - `_fetchAgentMdCache()` / `_checkAgentMdCache()` 改为直接读写 client 自身 `_agentMdCache`，不再读取旧 namespace 的 `_agentMdCache`。
    - 删除 `js/src/namespaces/auth.ts`、`js/src/namespaces/custody.ts`、`js/src/namespaces/meta.ts`，并移除空的 `js/src/namespaces` 目录。
  - JS 测试：
    - `client-agent-md-api.test.ts`、`client.test.ts` 的白盒 spy 从旧 `_authNamespace.*` 迁移到 `_uploadAgentMd` / `_downloadAgentMd` / `_verifyAgentMd` / `_headAgentMd`。
    - `auth-namespace.test.ts` 增加守卫，确认 `AUNClient` 内部 `_authNamespace` 不再存在。
  - 本轮 JS 回归：
    - TDD 失败确认：`cd js && npm run build` 首次失败，失败点为 fallback identity 的 `expires_at` 类型过宽。
    - 修复后：`cd js && npm run build`：通过。
    - `cd js && npx vitest run --environment jsdom tests/unit/client-agent-md-api.test.ts tests/unit/client.test.ts tests/unit/auth-namespace.test.ts tests/unit/meta-namespace.test.ts tests/unit/p0-common-gaps.test.ts --reporter=verbose`：5 files / 126 tests passed。
    - 静态扫描 `rg "_authNamespace|AuthNamespace|CustodyNamespace|MetaNamespace|from ['\\\"].*namespaces|src/namespaces" js/src js/tests -g "*.ts"`：无源码旧 namespace 依赖残留，仅剩守卫测试文案类命中。
    - `docs/aun测试运行指南.md` 已在 build/最小测试结束后重新读取。

## 最终收口核验

- 状态：已完成
- 2026-05-30 重新读取：
  - `docs/AUN_SDK_重构设计方案_v3.md`（内容版本 v4.0）
  - `docs/AUN_SDK_重构实施计划.md`
  - `docs/aun测试运行指南.md`
- 静态扫描：
  - `rg "readonly (auth|custody|meta)|this\.(auth|custody|meta)|new AuthNamespace|new MetaNamespace|new CustodyNamespace|from ['\"]\.\/namespaces|from ['\"].*namespaces|client\.(auth|meta|custody)" ts js -g "*.ts"`：无命中。
  - `rg "_authNamespace|AuthNamespace|CustodyNamespace|MetaNamespace|from ['\\\"].*namespaces|src/namespaces|\\.auth\\.|\\.meta\\.|\\.custody\\." ts/src ts/tests js/src js/tests -g "*.ts"`：无源码旧 namespace 依赖残留。
  - `Test-Path ts/src/namespaces` / `Test-Path js/src/namespaces`：均为 `False`，旧 namespace 目录已移除。
  - `rg "func \(c \*AUNClient\) (FetchAgentMD|CheckAgentMD|CheckAgentMd|SetAgentMDPath|SetAgentMdPath|ListIdentities|CheckGatewayHealth|Ping|Status|TrustRoots|LoadIdentityFromAID)\(" go/client.go`：无命中。
  - `rg "LoadIdentityFromAID|Connect\([^\n]*map\[string\]any|Connect\([^\n]*auth|Connect\([^\n]*authResult|\.Auth\.|\.Meta\.|\.Custody\." go -g "*.go"`：仅命中 `go/client_state_machine_test.go` 的严格 API 守卫字符串和 `go/transport.go` 的底层 `RPCTransport.Connect(ctx, url)`，不属于旧公开 AUNClient API。
  - `rg "register\(|exists\(|resolve\(|fetchAgentMd|headAgentMd|checkAgentMd|renewCert|rekey|diagnose" ts/src/aid-store.ts js/src/aid-store.ts go/aid_store.go -n`：TS/JS/Go `AIDStore` 联网方法均存在。
- 构造约束核验：
  - TS/JS `AUNClient` 构造重载为 `constructor(options?)` 与 `constructor(aid: AID, options?)`，运行时拒绝字符串 AID 和 `options.aid`。
  - Go `NewAUNClient` 支持 `NewAUNClient(*AID, options...)` 与 `NewAUNClient(options)`；`NewAUNClient("...")` 和 `AUNClientOptions{Raw: {"aid": "..."}}` 由单测负向守卫。
  - 旧 `new AUNClient(options, true|false)` 扫描命中均为负向守卫测试，或 `_connectOnce(..., true|false)` / 私有锁辅助调用，不属于构造入口残留。
- 当前结论：
  - TS/JS/Go 按设计完成三主体 API 收口，旧 `client.auth` / `client.meta` / `client.custody` namespace 不再作为公开入口。
  - Go 单域 integration、单域 E2E、双域 federation、双域 reconnect 已按串行要求完成 Docker 回归并通过。
  - 最后一次修改只更新本修改清单，未改 SDK 源码。

## 文档同步

- 状态：已完成
- 修改点：
  - `docs/sdk/01-快速开始.md`：重写快速开始为三主体模型，示例改为 `AIDStore.load/register/load` 后用 AID 对象构造 `AUNClient`。
  - `docs/sdk/03-核心概念.md`：更新 AID / AIDStore / AUNClient 职责和九态状态机。
  - `docs/sdk/04-连接与认证.md`：移除旧 namespace 调用链，说明 `AIDStore`、`AUNClient.authenticate()`、`connect(options)`、长短连接和 agent.md 新用法。
  - `docs/sdk/06-API手册.md`：重写为 AIDStore / AID / AUNClient / 事件 / E2EE 高级 API / RPC 索引，并记录 TS/JS/Go 构造入口约束。
  - `docs/sdk/07-错误处理.md`、`docs/sdk/08-最佳实践.md`：同步 Result、异常、幂等连接、多 AID 和 protected_headers 新用法。
  - `docs/sdk/README.md`、`docs/sdk/INDEX.md`、`docs/sdk/AUN_DOCS_GUIDE.md`：同步文档入口、索引和查阅指南，去除旧 `AuthNamespace` / `MetaNamespace` 为核心封装的表述。
  - `docs/sdk/02-WebSocket协议.md`：裸 WebSocket 示例中的 token 获取改为 `AIDStore` + `AUNClient.authenticate()`。
  - `docs/sdk/05-E2EE加密通信.md`、`docs/sdk/09-meta-rpc-manual.md`、`docs/sdk/09-custody-api-manual.md`：修正旧构造、meta namespace 和 custody 核心会话挂载说明。
  - 同步到 `D:\modelunion\aun-skill\.claude\skills\aun-sdk`：
    - 更新 `docs/quick-start.md`、`docs/authentication.md`、`docs/connection.md`、`docs/error-codes.md`。
    - 用 `docs/sdk` 当前版本覆盖 `sdk-core` 镜像文档。
    - 同步 meta RPC 手册到 `rpc-manual/meta/01-RPC-Manual.md`。
    - 更新 `SKILL.md` demo 骨架和排障说明，避免继续生成旧构造和旧 `client.auth` 调用。
