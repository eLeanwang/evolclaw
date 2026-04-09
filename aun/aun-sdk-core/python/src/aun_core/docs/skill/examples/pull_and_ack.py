"""
拉取消息并确认已读
==================

Receiver 拉取 Sender 发送的消息，然后确认已读。
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "aun-sdk-core", "python", "src"))

from _helpers import make_client, ensure_connected, close_clients, DEVICE_SHORT



async def main():
    sender = make_client("pull-sender")
    receiver = make_client("pull-reader")

    sender_aid = await ensure_connected(sender, f"demo-pull-sender-{DEVICE_SHORT}.agentid.pub")
    receiver_aid = await ensure_connected(receiver, f"demo-pull-reader-{DEVICE_SHORT}.agentid.pub")

    # ── Sender 发送几条消息 ──
    for i in range(3):
        await sender.call("message.send", {
            "to": receiver_aid,
            "type": "text",
            "payload": {"text": f"消息 #{i + 1}"},
            "persist": True,
        })
    print("Sender 发送了 3 条消息\n")

    # ── Receiver 拉取消息 ──
    await asyncio.sleep(0.3)
    result = await receiver.call("message.pull", {"after_seq": 0, "limit": 50})
    print(f"Receiver 拉取到 {result['count']} 条消息:")
    for msg in result["messages"]:
        print(f"  seq={msg['seq']} from={msg['from']}: {msg['payload']}")

    # ── Receiver 确认已读 ──
    if result["messages"]:
        max_seq = result["latest_seq"]
        ack = await receiver.call("message.ack", {"seq": max_seq})
        print(f"\nReceiver 确认已读: ack_seq={ack['ack_seq']}")

    await close_clients(sender, receiver)


asyncio.run(main())
