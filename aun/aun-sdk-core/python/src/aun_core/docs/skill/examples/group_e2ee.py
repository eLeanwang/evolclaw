"""
Group E2EE 群组加密消息
=======================

通过端到端加密发送群组消息，服务端只看到密文。
SDK 自动处理密钥创建、分发、轮换和恢复。

群组 E2EE 是必选能力，SDK 固定启用，无需额外配置。

前置条件:
  - Docker 环境运行中（docker compose up -d）

使用方法:
  python examples/group_e2ee.py
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "aun-sdk-core", "python", "src"))

from _helpers import make_client, ensure_connected, close_clients, DEVICE_SHORT


async def main():
    alice = make_client(f"ge-alice")
    bob = make_client(f"ge-bob")

    alice_aid = await ensure_connected(alice, f"demo-ge-alice-{DEVICE_SHORT}.agentid.pub")
    bob_aid = await ensure_connected(bob, f"demo-ge-bob-{DEVICE_SHORT}.agentid.pub")
    print(f"Alice: {alice_aid}\nBob:   {bob_aid}\n")

    # ── 1. Alice 建群（SDK 自动创建 epoch 1 并同步到服务端） ──
    result = await alice.call("group.create", {"name": "E2EE群"})
    group_id = result["group"]["group_id"]
    print(f"[1] 群组创建: {group_id}")
    print(f"    epoch={alice.group_e2ee.current_epoch(group_id)}")

    # ── 2. Alice 加 Bob（SDK 自动分发密钥给 Bob） ──
    await alice.call("group.add_member", {"group_id": group_id, "aid": bob_aid})
    print(f"[2] Bob 已加入群组")

    # 等待密钥分发完成
    await asyncio.sleep(2)

    # ── 3. Alice 发送加密群消息（group.send 默认加密） ──
    await alice.call("group.send", {
        "group_id": group_id,
        "payload": {"text": "这是一条群组加密消息", "secret": True},
    })
    print(f"[3] Alice 发送加密消息完成")

    # ── 4. Bob 接收（pull 自动解密） ──
    await asyncio.sleep(1)
    pull_result = await bob.call("group.pull", {
        "group_id": group_id,
        "after_message_seq": 0,
    })
    for msg in pull_result.get("messages", []):
        if msg.get("e2ee"):
            print(f"[4] Bob 收到: {msg['payload']}")
            print(f"    mode={msg['e2ee']['encryption_mode']}, epoch={msg['e2ee']['epoch']}")

    # ── 5. 查看状态 ──
    print(f"\n[状态]")
    print(f"  Alice epoch={alice.group_e2ee.current_epoch(group_id)}")
    print(f"  Bob   epoch={bob.group_e2ee.current_epoch(group_id)}")
    print(f"  成员列表={alice.group_e2ee.get_member_aids(group_id)}")

    await close_clients(alice, bob)


asyncio.run(main())
