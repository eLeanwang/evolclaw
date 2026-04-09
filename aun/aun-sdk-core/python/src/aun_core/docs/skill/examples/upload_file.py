"""
文件上传
========

演示两种上传方式：Inline 小对象上传和 Ticket 大文件上传。
"""

import asyncio
import base64
import hashlib
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

    # ── 方式 1：Inline 上传小对象（≤64KB） ──
    small_data = b"Hello, AUN Storage!"
    result = await client.call("storage.put_object", {
        "object_key": "demo/hello.txt",
        "content": base64.b64encode(small_data).decode(),
        "content_type": "text/plain",
        "is_private": False,
        "overwrite": True,
    })
    print(f"[Inline] 已上传: {result['object_key']} ({result['size_bytes']} bytes)")

    # ── 方式 2：Ticket 上传大文件 ──
    large_data = b"x" * 1024 * 100  # 100KB
    sha = hashlib.sha256(large_data).hexdigest()

    # 步骤 1: 申请上传 URL
    session = await client.call("storage.create_upload_session", {
        "object_key": "demo/large_file.bin",
        "size_bytes": len(large_data),
        "content_type": "application/octet-stream",
    })

    # 步骤 2: HTTP PUT 上传
    async with aiohttp.ClientSession() as http:
        await http.put(session["upload_url"], data=large_data)

    # 步骤 3: 确认上传
    result = await client.call("storage.complete_upload", {
        "object_key": "demo/large_file.bin",
        "size_bytes": len(large_data),
        "sha256": sha,
        "is_private": False,
    })
    print(f"[Ticket] 已上传: {result['object_key']} ({result['size_bytes']} bytes)")

    await close_clients(client)


asyncio.run(main())
