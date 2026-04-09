"""
创建群组并添加成员
==================

创建群组 → 添加成员 → 设置公告。
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "aun-sdk-core", "python", "src"))

from _helpers import make_client, ensure_connected, close_clients, DEVICE_SHORT



async def main():
    owner = make_client("grp-owner")
    member1 = make_client("grp-member1")
    member2 = make_client("grp-member2")

    owner_aid = await ensure_connected(owner, f"demo-grp-owner-{DEVICE_SHORT}.agentid.pub")
    m1_aid = await ensure_connected(member1, f"demo-grp-m1-{DEVICE_SHORT}.agentid.pub")
    m2_aid = await ensure_connected(member2, f"demo-grp-m2-{DEVICE_SHORT}.agentid.pub")
    print(f"Owner:   {owner_aid}\nMember1: {m1_aid}\nMember2: {m2_aid}\n")

    # ── 创建群组 ──
    result = await owner.call("group.create", {
        "name": "项目讨论组",
        "visibility": "public",
    })
    gid = result["group"]["group_id"]
    print(f"[1] 群组已创建: {gid}")

    # ── 成员加入 ──
    for client, name in [(member1, "Member1"), (member2, "Member2")]:
        await client.call("group.request_join", {"group_id": gid})
        print(f"[2] {name} 已加入")

    # ── 设置公告 ──
    await owner.call("group.update_announcement", {
        "group_id": gid,
        "content": "欢迎加入项目讨论组！请遵守群规。",
    })
    print("[3] 公告已设置")

    # ── 查看成员列表 ──
    members = await owner.call("group.get_members", {"group_id": gid})
    print(f"\n成员列表 ({members['total']} 人):")
    for m in members["members"]:
        print(f"  {m['aid']} — {m['role']}")

    await close_clients(owner, member1, member2)


asyncio.run(main())
