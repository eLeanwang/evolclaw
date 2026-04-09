"""
群聊消息收发
============

在群组中发送消息并拉取。
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "aun-sdk-core", "python", "src"))

from _helpers import make_client, ensure_connected, close_clients, DEVICE_SHORT



async def main():
    owner = make_client("gc-owner")
    member = make_client("gc-member")

    owner_aid = await ensure_connected(owner, f"demo-gc-owner-{DEVICE_SHORT}.agentid.pub")
    member_aid = await ensure_connected(member, f"demo-gc-member-{DEVICE_SHORT}.agentid.pub")

    # ── 创建群组，Member 加入 ──
    result = await owner.call("group.create", {
        "name": "聊天室",
        "visibility": "public",
    })
    gid = result["group"]["group_id"]
    await member.call("group.request_join", {"group_id": gid})
    print(f"群组: {gid}\n")

    # ── 发送群消息 ──
    await owner.call("group.send", {
        "group_id": gid,
        "type": "text",
        "payload": {"text": "大家好！"},
    })
    await member.call("group.send", {
        "group_id": gid,
        "type": "json",
        "payload": {
            "kind": "status_update",
            "text": "我已上线",
            "status": "online",
        },
    })
    print("Owner 和 Member 各发了一条消息")

    # ── 拉取群消息 ──
    await asyncio.sleep(0.3)
    pulled = await owner.call("group.pull", {
        "group_id": gid,
        "after_message_seq": 0,
        "after_event_seq": 0,
    })
    print(f"\n拉取到 {len(pulled['messages'])} 条消息:")
    for msg in pulled["messages"]:
        print(f"  {msg['sender_aid']}: {msg['payload']}")

    await close_clients(owner, member)


asyncio.run(main())
