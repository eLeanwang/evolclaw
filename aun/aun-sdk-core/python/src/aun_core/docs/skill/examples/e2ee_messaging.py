"""
E2EE 加密消息
=============

通过端到端加密发送消息，服务端无法解密内容。

SDK 使用 prekey_ecdh_v2（优先）或 long_term_key（降级）两级策略，
每条消息独立临时密钥对，实现一消息一密钥。

使用方法:
  python examples/e2ee_messaging.py
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "aun-sdk-core", "python", "src"))

from _helpers import make_client, ensure_connected, close_clients, DEVICE_SHORT


async def main():
    sender = make_client("e2ee-sender")
    receiver = make_client("e2ee-reader")

    sender_aid = await ensure_connected(sender, f"demo-e2ee-sender-{DEVICE_SHORT}.agentid.pub")
    receiver_aid = await ensure_connected(receiver, f"demo-e2ee-reader-{DEVICE_SHORT}.agentid.pub")
    print(f"Sender:   {sender_aid}\nReceiver: {receiver_aid}\n")

    # ── 1. Sender 发送加密消息（默认自动加密，SDK 自动处理） ──
    result = await sender.call("message.send", {
        "to": receiver_aid,
        "payload": {"text": "这是一条加密消息", "secret_data": "仅接收方可见"},
        "persist": True,
    })
    print(f"[1] 发送完成: seq={result.get('seq')}")

    # ── 2. Receiver 通过推送接收（自动解密） ──
    inbox = []
    event = asyncio.Event()

    def handler(msg):
        if isinstance(msg, dict) and msg.get("from") == sender_aid:
            inbox.append(msg)
            event.set()

    sub = receiver.on("message.received", handler)
    try:
        await asyncio.wait_for(event.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        pass
    sub.unsubscribe()

    # 推送没收到时 pull 兜底
    if not inbox:
        pull_result = await receiver.call("message.pull", {"after_seq": 0, "limit": 50})
        inbox.extend(m for m in pull_result.get("messages", []) if m.get("from") == sender_aid)

    for msg in inbox:
        print(f"[2] Receiver 收到: {msg['payload']}")
        print(f"    encrypted={msg.get('encrypted')}")
        print(f"    mode={msg.get('e2ee', {}).get('encryption_mode')}")

    await close_clients(sender, receiver)


asyncio.run(main())
