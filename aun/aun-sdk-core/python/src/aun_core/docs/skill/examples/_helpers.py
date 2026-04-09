"""
AUN-RPC-SDK 示例共享基础设施
============================

提供连接、认证、关闭的 boilerplate，让每个示例聚焦业务逻辑。

前置条件：
  1. pip install aun-core

环境变量（可选）：
  AUN_DATA_ROOT  — 数据存储根目录，默认 ~/.aun
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# Windows 终端默认编码可能是 cp936，强制 UTF-8 避免中文乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from aun_core import AUNClient, get_device_id

_DATA_ROOT = Path(os.environ.get("AUN_DATA_ROOT", "") or str(Path.home() / ".aun"))

# 设备 ID：同一台机器上固定不变，用于构造稳定的 AID
DEVICE_ID = get_device_id(_DATA_ROOT)
# 取前 8 位作为短标识，便于 AID 命名
DEVICE_SHORT = DEVICE_ID[:8]


def make_client(label: str | None = None) -> AUNClient:
    """创建一个 AUNClient 实例。

    label 用于区分同一台机器上的不同角色（如 sender/receiver）。
    不传 label 时使用默认 aun_path（~/.aun）。
    """
    if label:
        storage = _DATA_ROOT / label
        storage.mkdir(parents=True, exist_ok=True)
        return AUNClient({"aun_path": str(storage)})
    return AUNClient({"aun_path": str(_DATA_ROOT)})


async def ensure_connected(client: AUNClient, aid: str) -> str:
    """检查本地 identity → 按需 create_aid → 认证 → 连接。返回 AID。

    先检查本地存储是否有完整 identity（含 cert），有则直接 authenticate；
    无则 create_aid 注册新 AID 再 authenticate。避免对已注册的 AID 重复调 create。
    """
    local = client._auth._keystore.load_identity(aid)
    if local is None:
        await client.auth.create_aid({"aid": aid})

    auth = await client.auth.authenticate({"aid": aid})
    await client.connect({
        "access_token": auth["access_token"],
        "gateway": auth["gateway"],
        "auto_reconnect": True,
    })
    return aid


async def close_clients(*clients: AUNClient) -> None:
    """安全关闭多个客户端。"""
    for c in clients:
        try:
            await c.close()
        except Exception:
            pass
