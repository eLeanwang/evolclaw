"""
发送文本消息
============

向指定 AID 发送一条文本消息并检查送达状态。
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "aun-sdk-core", "python", "src"))

from _helpers import make_client, ensure_connected, close_clients, DEVICE_SHORT



async def main():
    sender = make_client("sender")
    receiver = make_client("receiver")

    sender_aid = await ensure_connected(sender, f"demo-sender-{DEVICE_SHORT}.agentid.pub")
    receiver_aid = await ensure_connected(receiver, f"demo-receiver-{DEVICE_SHORT}.agentid.pub")
    print(f"Sender:   {sender_aid}\nReceiver: {receiver_aid}\n")

    # ── 发送文本消息 ──
    result = await sender.call("message.send", {
        "to": receiver_aid,
        "type": "text",
        "payload": {"text": "你好！"},
        "persist": True,
    })
    print(f"发送结果: status={result['status']}, seq={result['seq']}")

    # ── 发送 JSON 消息 ──
    result = await sender.call("message.send", {
        "to": receiver_aid,
        "type": "json",
        "payload": {
            "kind": "greeting",
            "text": "这是一条结构化消息",
            "priority": "high",
        },
        "persist": True,
    })
    print(f"JSON 消息: status={result['status']}, seq={result['seq']}")

    await close_clients(sender, receiver)


asyncio.run(main())
