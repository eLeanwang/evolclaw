"""
文件下载
========

演示两种下载方式：Inline 读取小对象和 Ticket 下载大文件。
"""

import asyncio
import base64
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "aun-sdk-core", "python", "src"))

import aiohttp
from _helpers import make_client, ensure_connected, close_clients, DEVICE_SHORT



async def main():
    client = make_client("demo-storage")
    aid = await ensure_connected(client, f"demo-storage-{DEVICE_SHORT}.agentid.pub")
    print(f"AID: {aid}\n")

    # ── 先上传一个测试文件 ──
    await client.call("storage.put_object", {
        "object_key": "demo/readme.txt",
        "content": base64.b64encode(b"AUN Storage Demo").decode(),
        "content_type": "text/plain",
        "is_private": False,
        "overwrite": True,
    })

    # ── 方式 1：Inline 读取小对象 ──
    result = await client.call("storage.get_object", {
        "object_key": "demo/readme.txt",
    })
    content = base64.b64decode(result["content"])
    print(f"[Inline] 读取: {result['object_key']} = {content.decode()!r}")

    # ── 方式 2：Ticket 下载 ──
    ticket = await client.call("storage.create_download_ticket", {
        "object_key": "demo/readme.txt",
    })
    async with aiohttp.ClientSession() as http:
        async with http.get(ticket["download_url"]) as resp:
            data = await resp.read()
    print(f"[Ticket] 下载: {len(data)} bytes")

    # ── 列出对象 ──
    objects = await client.call("storage.list_objects", {"prefix": "demo/"})
    print(f"\n对象列表 ({objects['total']} 个):")
    for obj in objects["items"]:
        print(f"  {obj['object_key']} ({obj['size_bytes']} bytes)")

    await close_clients(client)


asyncio.run(main())
