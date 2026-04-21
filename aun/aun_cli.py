#!/usr/bin/env python3
"""AUN CLI 工具 — 交互式命令行客户端"""

import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import signal
import sqlite3
import sys
import time
import uuid
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from io import StringIO
from pathlib import Path

from packaging.requirements import Requirement

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ── 依赖自检 ──────────────────────────────────────────────────────────────
_REQUIRED_PACKAGES = [
    {"import": "aun_core", "requirement": "aun-core>=0.2.5"},
    {"import": "prompt_toolkit", "requirement": "prompt-toolkit>=3.0.0"},
    {"import": "rich", "requirement": "rich>=13.0.0"},
]


def _ensure_deps():
    """检查第三方依赖，缺失或版本过低时自动升级，完成后重启进程。"""
    pending = []
    for item in _REQUIRED_PACKAGES:
        import_name = item["import"]
        requirement_text = item["requirement"]
        requirement = Requirement(requirement_text)
        try:
            __import__(import_name)
            installed = version(requirement.name)
        except (ImportError, PackageNotFoundError):
            pending.append(requirement_text)
            continue
        if installed not in requirement.specifier:
            pending.append(requirement_text)
    if not pending:
        return
    print(f"[aun] 正在安装或升级依赖: {', '.join(pending)} ...")
    import subprocess
    sources = [
        ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--trusted-host", "pypi.tuna.tsinghua.edu.cn"],
        [],  # 默认 PyPI
    ]
    for i, src_args in enumerate(sources):
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "-U", "-q", *src_args, *pending],
                stdout=sys.stdout, stderr=sys.stderr,
            )
            break
        except subprocess.CalledProcessError:
            if i < len(sources) - 1:
                print("[aun] 镜像源安装失败，尝试默认源 ...")
            else:
                print("[aun] 依赖安装失败，请手动安装:", " ".join(pending))
                raise SystemExit(1)
    print("[aun] 依赖安装完成，正在重启 ...")
    os.execv(sys.executable, [sys.executable] + sys.argv)

def _ensure_ssl_certs():
    """macOS 上无条件使用 certifi 证书，避免系统证书缺失问题。"""
    if sys.platform != "darwin":
        return
    try:
        import certifi
    except ImportError:
        # certifi 还没装，先用 pip 内置的证书保证 pip install 能跑
        pip_certifi = os.path.join(
            os.path.dirname(os.__file__),
            "site-packages", "pip", "_vendor", "certifi", "cacert.pem",
        )
        if os.path.exists(pip_certifi):
            os.environ["SSL_CERT_FILE"] = pip_certifi
        return
    cert_path = certifi.where()
    os.environ["SSL_CERT_FILE"] = cert_path
    os.environ["REQUESTS_CA_BUNDLE"] = cert_path
    import ssl
    _orig = ssl.create_default_context
    def _patched(purpose=ssl.Purpose.SERVER_AUTH, *, cafile=None, capath=None, cadata=None):
        if cafile is None and capath is None and cadata is None:
            cafile = cert_path
        return _orig(purpose, cafile=cafile, capath=capath, cadata=cadata)
    ssl.create_default_context = _patched

# 先修 SSL（否则 pip install 可能也连不上），再装依赖，再用完整 certifi 重新修
_ensure_ssl_certs()
_ensure_deps()
_ensure_ssl_certs()

from aun_core import AUNClient
from aun_core.keystore.file import FileKeyStore

# ── SDK monkey-patches ───────────────────────────────────────────────────────
# Bug 1: E2EEManager 缺少 clean_expired_caches()，client._cache_cleanup_loop 会 AttributeError
# Bug 2: GroupE2EEManager.clean_expired_caches 引用不存在的 _prekey_cache
# Bug 3: _encrypt_with_prekey/_encrypt_with_long_term_key 中 sender_fingerprint fallback 到 SPKI
def _patch_sdk():
    from aun_core.e2ee import E2EEManager, GroupE2EEManager
    from aun_core.errors import E2EEError
    import time as _t

    if not hasattr(E2EEManager, "clean_expired_caches"):
        def _clean_expired(self):
            now = _t.time()
            for k in list(self._prekey_cache):
                _, exp = self._prekey_cache[k]
                if now >= exp:
                    del self._prekey_cache[k]
        E2EEManager.clean_expired_caches = _clean_expired

    # GroupE2EEManager 无 _prekey_cache，原方法会崩溃，替换为 no-op
    GroupE2EEManager.clean_expired_caches = lambda self: None

    # sender_cert_fingerprint 必须是 cert DER fingerprint，不能 fallback 到 SPKI
    # 修复 _encrypt_with_prekey 和 _encrypt_with_long_term_key 中的 fallback 逻辑
    _orig_prekey = E2EEManager._encrypt_with_prekey
    _orig_longterm = E2EEManager._encrypt_with_long_term_key

    def _patched_prekey(self, peer_aid, payload, prekey, peer_cert_pem, *, message_id=None, timestamp=None):
        # 调用原方法前，确保 _local_cert_fingerprint 不会 fallback
        fp = self._local_cert_sha256_fingerprint()
        if not fp:
            raise E2EEError("local cert unavailable — cannot encrypt with prekey")
        return _orig_prekey(self, peer_aid, payload, prekey, peer_cert_pem, message_id=message_id, timestamp=timestamp)

    def _patched_longterm(self, peer_aid, payload, peer_cert_pem, *, message_id=None, timestamp=None):
        # 调用原方法前，确保 _local_cert_fingerprint 不会 fallback
        fp = self._local_cert_sha256_fingerprint()
        if not fp:
            raise E2EEError("local cert unavailable — cannot encrypt with long-term key")
        return _orig_longterm(self, peer_aid, payload, peer_cert_pem, message_id=message_id, timestamp=timestamp)

    E2EEManager._encrypt_with_prekey = _patched_prekey
    E2EEManager._encrypt_with_long_term_key = _patched_longterm

_patch_sdk()
del _patch_sdk
from prompt_toolkit import Application, PromptSession
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import ANSI, HTML
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout.containers import HSplit, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.layout import Layout
from prompt_toolkit.output import ColorDepth
from prompt_toolkit.validation import Validator, ValidationError
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.shortcuts import print_formatted_text
from prompt_toolkit.styles import Style
from rich.console import Console as RichConsole
from rich.markdown import Markdown as RichMarkdown
from rich.theme import Theme as RichTheme

# ── 配置 ──────────────────────────────────────────────────────────────────

GATEWAY_HOST = "gateway.agentid.pub"
DEFAULT_GATEWAY_PORT = None  # 默认不指定端口（使用标准 443）
GATEWAY_URL = None  # 运行时由 _init_globals() 设置

def _gateway_cert_url(aid: str) -> str:
    """构造 Gateway 证书查询 URL。"""
    from urllib.parse import quote, urlparse, urlunparse
    parsed = urlparse(GATEWAY_URL)
    scheme = "https" if parsed.scheme == "wss" else "http"
    return urlunparse((scheme, parsed.netloc, f"/pki/cert/{quote(aid, safe='')}", "", "", ""))

async def _aid_exists(aid: str) -> bool:
    """向 Gateway 查询 AID 是否存在（HTTP GET /pki/cert/{aid}）。"""
    import aiohttp
    url = _gateway_cert_url(aid)
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                return resp.status == 200
    except Exception:
        return False

# 全局变量（运行时初始化）
AUN_PATH = None   # SDK 数据根目录（~/.aun），AIDs 在 {AUN_PATH}/AIDs/ 下
DATA_DIR = None   # CLI 私有数据（~/.aun/aun-cli），存 history、config
DOWNLOADS_DIR = None  # 文件下载目录（~/.aun/aun-cli/downloads）
HISTORY_FILE = None
_CONFIG_FILE = None

def _init_globals():
    """初始化全局配置变量。"""
    global AUN_PATH, DATA_DIR, DOWNLOADS_DIR, HISTORY_FILE, _CONFIG_FILE, GATEWAY_URL
    env = os.environ.get("AUN_CLI_DATA", "").strip()
    base = Path(env) if env else Path.home() / ".aun"
    AUN_PATH = base
    DATA_DIR = base / "aun-cli"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR = DATA_DIR / "downloads"
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE = DATA_DIR / ".history"
    _CONFIG_FILE = DATA_DIR / "config.json"
    # gateway port: config > default (empty = standard 443)
    port = str(_load_config().get("gateway_port", "") or "")
    if port:
        GATEWAY_URL = f"wss://{GATEWAY_HOST}:{port}/aun"
    else:
        GATEWAY_URL = f"wss://{GATEWAY_HOST}/aun"

def _load_config() -> dict:
    """加载 CLI 配置。"""
    if _CONFIG_FILE and _CONFIG_FILE.exists():
        try:
            return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}

def _save_config(cfg: dict):
    """保存 CLI 配置。"""
    if _CONFIG_FILE:
        _CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        _CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ── 数据日志查看（aun --log N）────────────────────────────────────────────

_LOG_LINE_PREFIX_RE = re.compile(r'^(\[[^\]]+\] \[[^\]]+\])\s*(.*)')
_LOG_LINE_PARSE_RE = re.compile(r'^\[([^\]]+)\]\s+\[([^\]]+)\]\s*(.*)$')


def _highlight_json(compact: str) -> str:
    """渲染紧凑 JSON：key 蓝色、字符串值绿色、数字/布尔/null 黄色。"""
    KEY, STR, NUM = '\x1b[94m', '\x1b[92m', '\x1b[93m'
    RESET = '\x1b[0m'
    out = []
    i, n = 0, len(compact)
    expect_key = False  # 进入对象后，下一个字符串是 key

    def read_string(start: int) -> int:
        j = start + 1
        while j < n:
            c = compact[j]
            if c == '\\' and j + 1 < n:
                j += 2
                continue
            if c == '"':
                return j + 1
            j += 1
        return n

    while i < n:
        c = compact[i]
        if c == '{':
            out.append(c)
            expect_key = True
            i += 1
        elif c == '}':
            out.append(c)
            i += 1
        elif c == '[':
            out.append(c)
            expect_key = False
            i += 1
        elif c == ']':
            out.append(c)
            i += 1
        elif c == ':':
            out.append(c)
            expect_key = False
            i += 1
        elif c == ',':
            out.append(c)
            # 逗号后的位置：若最近的容器是对象则下一项是 key。简单启发：找到最近未闭合的 {
            depth = 0
            j = len(out) - 1
            in_obj = False
            while j >= 0:
                tok = out[j]
                if tok == ']':
                    depth += 1
                elif tok == '[':
                    if depth == 0:
                        break
                    depth -= 1
                elif tok == '}':
                    depth += 1
                elif tok == '{':
                    if depth == 0:
                        in_obj = True
                        break
                    depth -= 1
                j -= 1
            expect_key = in_obj
            i += 1
        elif c == '"':
            end = read_string(i)
            token = compact[i:end]
            color = KEY if expect_key else STR
            out.append(f"{color}{token}{RESET}")
            i = end
        elif c.isspace():
            out.append(c)
            i += 1
        else:
            # number / true / false / null
            j = i
            while j < n and compact[j] not in ',]}:':
                j += 1
            token = compact[i:j]
            out.append(f"{NUM}{token}{RESET}")
            i = j
    return ''.join(out)


def _current_log_path(now: "datetime | None" = None) -> Path:
    """返回当天数据日志文件路径。"""
    current = now or datetime.now()
    return DATA_DIR / "logs" / f"aun-{current.strftime('%Y%m%d')}.log"


def _render_log_line(line: str) -> str:
    """将日志行渲染为带 ANSI 颜色的终端输出。"""
    line = _format_log_line(line)
    m = _LOG_LINE_PARSE_RE.match(line)
    if not m:
        return line

    ts, direction, payload = m.group(1), m.group(2), m.group(3)
    stripped = payload.lstrip()
    if stripped.startswith('{') or stripped.startswith('['):
        try:
            obj = json.loads(stripped)
            compact = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
            rendered_payload = _highlight_json(compact)
        except Exception:
            rendered_payload = _render_md(_replace_emoji(payload))
    else:
        rendered_payload = _render_md(_replace_emoji(payload))
    return f"{C.DIM}{ts}\033[22m {C.WHITE}[{direction}]\033[39m  {rendered_payload}"


def _emit_log_line(line: str):
    """TTY 下走 ANSI 渲染，非 TTY 下输出纯文本，便于管道处理。"""
    rendered = _render_log_line(line)
    if hasattr(sys.stdout, 'isatty') and sys.stdout.isatty():
        _p(rendered)
    else:
        print(_format_log_line(line), flush=True)


def _format_log_line(line: str) -> str:
    """保留 [时间] [方向] 前缀，将后半段的 JSON payload 压缩成单行。"""
    line = line.rstrip('\n')
    m = _LOG_LINE_PREFIX_RE.match(line)
    if not m:
        return line
    prefix, rest = m.group(1), m.group(2)
    try:
        obj = json.loads(rest)
    except Exception:
        return line
    return f"{prefix} {json.dumps(obj, ensure_ascii=False, separators=(',', ':'))}"


def _tail_last_lines(path: Path, count: int) -> list[str]:
    """返回日志文件的最后 count 行（不含换行符）。"""
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except FileNotFoundError:
        return []
    if count <= 0:
        return []
    return lines[-count:]


def _stat_identity(path: Path) -> "dict | None":
    """采集文件身份信息，用于检测轮转。"""
    try:
        st = path.stat()
    except OSError:
        return None
    return {
        'st_ino': getattr(st, 'st_ino', 0),
        'st_mtime_ns': getattr(st, 'st_mtime_ns', int(st.st_mtime * 1_000_000_000)),
        'st_size': st.st_size,
    }


def _same_file_identity(left: "dict | None", right: "dict | None") -> bool:
    """判断两个 stat 结果是否来自同一文件（跨平台回退）。"""
    if not left or not right:
        return False
    left_ino = left.get('st_ino') or 0
    right_ino = right.get('st_ino') or 0
    if left_ino and right_ino:
        return left_ino == right_ino
    return (
        left.get('st_mtime_ns') == right.get('st_mtime_ns')
        and left.get('st_size') == right.get('st_size')
    )


def _should_reopen_for_truncation(position: int, size: int) -> bool:
    """当前读取偏移大于文件大小时，说明文件被截断/重建。"""
    return position > size


def _validate_log_mode_args(argv: list, log_value: "int | None", subcmd: "str | None"):
    """`--log` 模式必须单独使用，任何混用都以退出码 2 拒绝。"""
    if log_value is None:
        return
    if log_value <= 0 or subcmd:
        raise SystemExit(2)
    args = list(argv[1:])
    i = 0
    seen_log = False
    while i < len(args):
        arg = args[i]
        if arg in ('--log', '-L'):
            if seen_log or i + 1 >= len(args):
                raise SystemExit(2)
            seen_log = True
            i += 2
            continue
        if arg.startswith('--log='):
            if seen_log:
                raise SystemExit(2)
            seen_log = True
            i += 1
            continue
        raise SystemExit(2)
    if not seen_log:
        raise SystemExit(2)


async def _follow_log_output(count: int) -> None:
    """打印当天日志最后 count 行后持续跟随，支持跨天轮转。"""
    path = _current_log_path()
    if not path.exists():
        error('未找到当天日志文件，请先开启日志写入')
        raise SystemExit(1)

    for line in _tail_last_lines(path, count):
        _emit_log_line(line)

    current_path = path
    handle = current_path.open('r', encoding='utf-8')
    handle.seek(0, os.SEEK_END)
    identity = _stat_identity(current_path)

    try:
        while True:
            line = handle.readline()
            if line:
                _emit_log_line(line)
                continue

            await asyncio.sleep(0.2)

            latest_path = _current_log_path()
            if latest_path != current_path:
                if latest_path.exists():
                    handle.close()
                    current_path = latest_path
                    handle = current_path.open('r', encoding='utf-8')
                    identity = _stat_identity(current_path)
                continue

            latest_identity = _stat_identity(current_path)
            if latest_identity is None:
                continue
            if _should_reopen_for_truncation(handle.tell(), latest_identity['st_size']):
                handle.close()
                handle = current_path.open('r', encoding='utf-8')
                identity = _stat_identity(current_path)
                continue
            if identity is not None and not _same_file_identity(identity, latest_identity):
                handle.close()
                handle = current_path.open('r', encoding='utf-8')
                identity = _stat_identity(current_path)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            handle.close()
        except Exception:
            pass


# AID 合法性：域名格式，每段只允许字母、数字、连字符，至少三段（name.domain.tld）
_AID_LABEL_RE = re.compile(r'^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$')

def _is_valid_aid(name: str) -> bool:
    """检查 AID 是否为合法域名（至少三级，如 alice.agentid.pub）。"""
    labels = name.split('.')
    return len(labels) >= 3 and all(_AID_LABEL_RE.match(label) for label in labels)

def _validate_aid(name: str) -> bool:
    """校验 AID 格式，无效时打印错误。返回是否有效。"""
    if _is_valid_aid(name):
        return True
    error(f"无效 AID: {name}（需要合法域名格式）")
    return False

def _short_name(aid: str) -> str:
    """AID → 首段短名（如 alice.agentid.pub → alice）。"""
    return aid.split(".")[0] if aid else "?"


def _strip_send_result(result):
    """精简 SDK send 返回值：剔除 E2EE 密文 payload 和重复的 event 块。"""
    if not isinstance(result, dict):
        return result
    stripped = {}
    for k, v in result.items():
        if k == "event":
            # event 和 message 信息重复，跳过
            continue
        if k == "message" and isinstance(v, dict):
            # 保留 message 但剔除 payload（E2EE 密文材料）
            stripped[k] = {mk: mv for mk, mv in v.items() if mk != "payload"}
        else:
            stripped[k] = v
    return stripped

MAX_RECENT_TARGETS = 10
_last_recorded_target = None  # 避免对同一 target 连续写磁盘
_targets_cache = None          # 内存缓存，避免补全时每次按键读磁盘

# ── Target 模型 ───────────────────────────────────────────────────────────
# target 统一结构：{"type": "peer"|"group", "id": str, "name": str}

def _is_peer_target(target) -> bool:
    return isinstance(target, dict) and target.get("type") == "peer"

def _is_group_target(target) -> bool:
    return isinstance(target, dict) and target.get("type") == "group"

def _is_group_id(value: str) -> bool:
    """判断字符串是否为 group_id（g-xxx.agentid.pub 或 grp_ 开头）。"""
    if not value:
        return False
    if value.startswith("grp_"):
        return True
    # g-xxx.agentid.pub 格式
    if value.startswith("g-") and value.endswith(".agentid.pub"):
        return True
    return False

_MENTION_RE = re.compile(r'@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?){2,})')

def _extract_mentions(text: str) -> list[str]:
    """从文本中提取所有 @aid mention（不含行首 @）。"""
    return _MENTION_RE.findall(text)

def _normalize_target(value) -> dict | None:
    """将各种输入格式规范化为 target dict。"""
    if isinstance(value, dict) and value.get("type") in ("peer", "group"):
        return value
    if isinstance(value, str) and value:
        if _is_group_id(value):
            return {"type": "group", "id": value, "name": value}
        if _is_valid_aid(value):
            return {"type": "peer", "id": value, "name": _short_name(value)}
    return None

def _normalize_recent_targets(cfg: dict) -> list[dict]:
    """从配置加载 recent_targets，并过滤掉结构无效的条目。"""
    targets = cfg.get("recent_targets", [])
    if not isinstance(targets, list):
        return []
    normalized: list[dict] = []
    for t in targets:
        if not isinstance(t, dict):
            continue
        ttype = t.get("type")
        tid = str(t.get("id") or "")
        name = str(t.get("name") or tid)
        if ttype == "peer" and _is_valid_aid(tid):
            normalized.append({"type": "peer", "id": tid, "name": name})
        elif ttype == "group" and _is_group_id(tid):
            normalized.append({"type": "group", "id": tid, "name": name})
    return normalized

def _target_label(target) -> str:
    """返回 target 的显示标签。peer: AID, group: [群名]"""
    if not isinstance(target, dict):
        return str(target) if target else "未设置"
    if target.get("type") == "group":
        return f'[{target.get("name", target.get("id", "?"))}]'
    return target.get("id", "?")

def _target_short_name(target) -> str:
    """返回 target 的短名。peer: 首段, group: 群名"""
    if not isinstance(target, dict):
        return _short_name(str(target)) if target else "?"
    if target.get("type") == "group":
        return target.get("name", target.get("id", "?"))
    return _short_name(target.get("id", "?"))

def _record_target(target: dict):
    """记录成功通信过的 target（最近 10 个，最新在前）。"""
    global _last_recorded_target, _targets_cache
    if not target or not isinstance(target, dict):
        return
    tid = target.get("id")
    if not tid or tid == "?" or (isinstance(_last_recorded_target, dict) and _last_recorded_target.get("id") == tid):
        return
    _last_recorded_target = target
    cfg = _load_config()
    targets = _normalize_recent_targets(cfg)
    if targets and targets[0].get("id") == tid:
        # 可能 name 有更新，覆盖
        targets[0] = target
        cfg["recent_targets"] = targets
        _save_config(cfg)
        _targets_cache = targets
        return
    targets = [t for t in targets if t.get("id") != tid]
    targets.insert(0, target)
    cfg["recent_targets"] = targets[:MAX_RECENT_TARGETS]
    _save_config(cfg)
    _targets_cache = cfg["recent_targets"]

def _get_recent_targets() -> list[dict]:
    """返回最近目标列表（优先内存缓存）。"""
    global _targets_cache
    if _targets_cache is None:
        _targets_cache = _normalize_recent_targets(_load_config())
    return _targets_cache

def _find_group_in_targets(value: str) -> dict | None:
    """在 recent_targets 中按 group_id 或群名查找 group target。"""
    for t in _get_recent_targets():
        if t.get("type") != "group":
            continue
        if t.get("id") == value or t.get("name") == value:
            return t
    return None


def _is_group_not_joined_error(exc: Exception | str | None) -> bool:
    if not exc:
        return False
    text = str(exc).lower()
    return "no group secret" in text or "not a member" in text


def _join_mode_from_requirements(result: dict | None, error: Exception | None = None) -> str:
    reqs = result.get("join_requirements", {}) if isinstance(result, dict) else {}
    mode = reqs.get("mode", "")
    if mode == "closed":
        return "closed"
    if mode == "invite_only":
        return "invite_only"
    if mode in ("open", "approval"):
        return mode
    if _is_not_member_error(error):
        return "unknown"
    return mode or "unknown"


def _should_handle_join_as_target_switch(line: str) -> bool:
    if not line.startswith("@"):
        return False
    parts = line[1:].split(None, 1)
    if not parts:
        return False
    target = parts[0]
    return _is_group_id(target) or _is_valid_aid(target)


def _split_target_switch_input(line: str) -> tuple[str, str]:
    parts = line[1:].split(None, 1)
    target = parts[0] if parts else ""
    message = parts[1] if len(parts) > 1 else ""
    return target, message


def _make_client() -> "AUNClient":
    """构造 AUNClient，统一 aun_path 配置。"""
    return AUNClient({"aun_path": str(AUN_PATH)})

def _get_keystore() -> "FileKeyStore":
    """获取与 _make_client 同路径的 FileKeyStore 实例。"""
    return FileKeyStore(AUN_PATH)

# ── 样式 ──────────────────────────────────────────────────────────────────

STYLE = Style.from_dict({
    "prompt":              "#ffff00 bold",
    "spinner":             "#888888 nobold",
    "bottom-toolbar":      "bg:#1a1a2e #aaaaaa",
    "validation-toolbar":  "bg:#1a1a2e #ff6666",
})

_LOCAL_CMDS = [
    ("//debug",      "",    "toggle 调试模式"),
    ("//log",        "",    "toggle 数据日志（写入文件）"),
    ("//history",    "N",   "查看历史消息（默认20条）"),
    ("//plain",      "",    "切换 明文/E2EE"),
    ("//target",     "aid", "设置目标（或用 @）"),
    ("//sendfile",   "path","发送文件到当前目标"),
    ("//ping",       "",    "Ping 网关"),
    ("//processing", "",    "当前处理状态"),
    ("//rawdata",    "",    "最后消息原始内容"),
    ("//e2ee",       "",    "E2EE 状态"),
    ("//status",     "",    "连接状态"),
    ("//local",      "name", "切换本地 AID"),
    ("//aid",        "cmd",  "AID 管理"),
    ("//qid",        "cmd", "群组管理"),
    ("//help",       "",    "帮助"),
    ("//quit",       "",    "退出"),
]

# 群命令表: (命令名, 别名列表, 描述, 需要当前群, 菜单可见)
_GROUP_COMMANDS = [
    ("list",     [],          "成员列表",                         True,  True),
    ("info",     [],          "群组信息（含公告）",              True,  True),
    ("user",     ["u"],      "成员管理（+ 添加，- 踢出，ban/unban）", True, True),
    ("join",     [],          "入群管理（inv 邀请码，req 申请）", True,  True),
    ("setup",    ["set"],    "群设置（name/desc/notice/mode/role）", True, True),
    ("group",    ["g"],      "群管理（transfer/suspend/resume/dissolve）", True, True),
    ("quit",     [],          "退出群组",                         True,  True),
]
_OWNER_ONLY_GROUP_COMMANDS = {"user", "join", "setup", "group"}


def _filter_group_commands_for_owner(is_owner: bool | None):
    if is_owner is not True:
        return [cmd for cmd in _GROUP_COMMANDS if cmd[0] not in _OWNER_ONLY_GROUP_COMMANDS]
    return list(_GROUP_COMMANDS)

# 构建命令查找表: name/alias → (cmd_name, need_group)
_GROUP_CMD_LOOKUP = {}
for _cn, _aliases, _desc, _ng, _vis in _GROUP_COMMANDS:
    _GROUP_CMD_LOOKUP[_cn] = (_cn, _ng)
    for _a in _aliases:
        _GROUP_CMD_LOOKUP[_a] = (_cn, _ng)

async def _async_input(prompt_text: str) -> str:
    """在 asyncio 环境中异步读取用户输入（使用 prompt_toolkit）。"""
    session = PromptSession()
    try:
        result = await session.prompt_async(prompt_text)
        return result
    except (EOFError, KeyboardInterrupt):
        raise

class AUNValidator(Validator):
    """输入验证：@ 后的目标格式检查（AID / group_id / 群名）。"""
    def validate(self, document):
        text = document.text.strip()
        if text.startswith("@"):
            parts = text[1:].split(None, 1)
            name = parts[0] if parts else ""
            # 空值、AID、group_id、群名都放行
            if name and not _is_valid_aid(name) and not _is_group_id(name):
                # 可能是群名，不强校验
                pass
        # / 前缀的群命令通过 repl 分发，不做强约束

class AUNCompleter(Completer):
    """补全菜单：/ 远端命令，// 本地命令，@ 目标切换（peer+group），# 群命令。"""

    def __init__(self, cli_ref=None):
        self.cli_ref = cli_ref  # AUNCli 实例引用，用于读取 _pending_menu

    def get_completions(self, document, complete_event):
        raw = document.text_before_cursor
        text = raw.lstrip()
        if not text:
            return

        # @ 补全：任意位置触发，统一弹出联系人/成员列表
        # 行首 @ 和行中 @ 都触发；选中后补全为 //target（切换）或 @aid（mention）
        at_pos = -1
        if text[0] == '@':
            at_pos = 0
        else:
            last_space = text.rfind(' ')
            if last_space >= 0 and last_space + 1 < len(text) and text[last_space + 1] == '@':
                at_pos = last_space + 1

        if at_pos >= 0:
            is_in_group = self.cli_ref and self.cli_ref.target and _is_group_target(self.cli_ref.target)
            after_at = text[at_pos + 1:]
            at_len = len(text) - at_pos

            if ' ' in after_at:
                pass  # 已选目标/成员，不再补全 — fall through
            elif is_in_group:
                # 群聊：群成员（mention）+ 所有目标（切换，补全为 //target）
                filter_text = after_at.lower()
                # 群成员（缓存为空时触发后台加载）
                group_id = self.cli_ref.target.get("id", "")
                members = self.cli_ref._get_members(group_id)
                if not members and self.cli_ref.connected:
                    asyncio.ensure_future(self.cli_ref._ensure_members_cache(group_id, force=True))
                for m in members:
                    mid = m.get("aid", "")
                    if not mid or mid == self.cli_ref.my_aid:
                        continue
                    role = m.get("role", "")
                    role_tag = f" [{role}]" if role else ""
                    short = _short_name(mid)
                    display = f"{short}{role_tag}"
                    if filter_text and not (short.lower().startswith(filter_text) or mid.lower().startswith(filter_text)):
                        continue
                    yield Completion(f"@{mid} ", start_position=-at_len,
                                     display=display, display_meta=mid)
                # 切换目标列表
                targets = _get_recent_targets()
                grp_cache = self.cli_ref._group_cache if self.cli_ref else []
                recent_ids = {t.get("id") for t in targets}
                for g in (grp_cache or []):
                    gid = g.get("group_id", "")
                    if gid and gid not in recent_ids:
                        targets.append({"type": "group", "id": gid, "name": g.get("name", gid)})
                if self.cli_ref:
                    try:
                        unread = self.cli_ref.store.unread_counts()
                    except Exception:
                        unread = {}
                    existing_ids = {t.get("id") for t in targets}
                    for cid in unread:
                        if cid in existing_ids:
                            continue
                        if _is_valid_aid(cid):
                            targets.append({"type": "peer", "id": cid, "name": _short_name(cid)})
                else:
                    unread = {}
                current_id = self.cli_ref.target.get("id") if self.cli_ref.target else None
                for t in targets:
                    tid = t.get("id", "")
                    if tid == current_id:
                        continue
                    tname = t.get("name", "")
                    if filter_text and not (tname.lower().startswith(filter_text) or tid.lower().startswith(filter_text)):
                        continue
                    display = f"→ {tname or _short_name(tid)}"
                    yield Completion(f"//target {tid}", start_position=-at_len,
                                     display=display, display_meta="切换")
                return
            else:
                # 非群聊：所有联系人列表，选中后补全为 //target
                filter_text = after_at.lower()
                targets = _get_recent_targets()
                group_cache = self.cli_ref._group_cache if self.cli_ref else []
                recent_ids = {t.get("id") for t in targets}
                for g in (group_cache or []):
                    gid = g.get("group_id", "")
                    if gid and gid not in recent_ids:
                        targets.append({"type": "group", "id": gid, "name": g.get("name", gid)})
                if self.cli_ref:
                    try:
                        unread = self.cli_ref.store.unread_counts()
                    except Exception:
                        unread = {}
                    existing_ids = {t.get("id") for t in targets}
                    for cid in unread:
                        if cid in existing_ids:
                            continue
                        if _is_valid_aid(cid):
                            targets.append({"type": "peer", "id": cid, "name": _short_name(cid)})
                else:
                    unread = {}
                if not targets:
                    yield Completion("@", start_position=-at_len,
                                     display="(无最近联系人)", display_meta="使用 //target <aid>")
                    return
                def _sort_key(t):
                    tid = t.get("id", "")
                    cnt = unread.get(tid, 0)
                    if cnt > 0:
                        return (0, -cnt)
                    try:
                        last_ts = self.cli_ref.store.last_message_time(tid) if self.cli_ref else 0
                    except Exception:
                        last_ts = 0
                    return (1, -(last_ts or 0))
                targets.sort(key=_sort_key)
                current_id = self.cli_ref.target.get("id") if self.cli_ref and self.cli_ref.target else None
                for t in targets:
                    tid = t.get("id", "")
                    tname = t.get("name", "")
                    is_current = " ✓" if tid == current_id else ""
                    cnt = unread.get(tid, 0)
                    unread_tag = f" (未读{cnt}条)" if cnt > 0 else ""
                    display = f"{tname}{unread_tag}{is_current}"
                    if filter_text and not (tname.lower().startswith(filter_text) or tid.lower().startswith(filter_text)):
                        continue
                    yield Completion(f"//target {tid} ", start_position=-at_len,
                                     display=display, display_meta=tid)
                return

        if text[0] != '/':
            return

        # // 前缀：本地命令菜单
        if text.startswith("//"):
            filter_text = text[2:]

            # //local 二级补全：本地 AID 列表（仅切换）
            if filter_text.startswith("local ") or filter_text == "local":
                aid_filter = filter_text[6:].lower() if len(filter_text) > 6 else ""
                ks = _get_keystore()
                aids_root = ks._aids_root
                current_aid = self.cli_ref.my_aid if self.cli_ref else ""
                if aids_root.exists():
                    valid_aids = []
                    for p in aids_root.iterdir():
                        if not p.is_dir():
                            continue
                        aid_name = p.name
                        identity = ks.load_identity(aid_name)
                        if not isinstance(identity, dict) or not identity.get("private_key_pem"):
                            continue
                        valid_aids.append(aid_name)
                    for aid_name in sorted(valid_aids):
                        if aid_filter and not aid_name.lower().startswith(aid_filter):
                            continue
                        is_current = " ✓" if aid_name == current_aid else ""
                        yield Completion(f"//local {aid_name}", start_position=-len(text),
                                         display=f"{aid_name}{is_current}", display_meta="切换")
                return

            # //aid 二级补全：本地 AID 管理命令
            if filter_text.startswith("aid ") or filter_text == "aid":
                aid_filter = filter_text[4:].lower() if len(filter_text) > 4 else ""
                sub_cmds = [("list", "列出所有 AID"), ("new", "创建新 AID"), ("delete", "删除 AID")]
                for sc, desc in sub_cmds:
                    if aid_filter and not sc.startswith(aid_filter):
                        continue
                    yield Completion(f"//aid {sc} ", start_position=-len(text),
                                     display=f"{sc}", display_meta=desc)
                return

            # //target 二级补全：目标列表
            if filter_text.startswith("target ") or filter_text == "target":
                target_filter = filter_text[7:].lower() if len(filter_text) > 7 else ""
                targets = _get_recent_targets()
                group_cache = self.cli_ref._group_cache if self.cli_ref else []
                recent_ids = {t.get("id") for t in targets}
                for g in (group_cache or []):
                    gid = g.get("group_id", "")
                    if gid and gid not in recent_ids:
                        targets.append({"type": "group", "id": gid, "name": g.get("name", gid)})
                if self.cli_ref:
                    try:
                        unread = self.cli_ref.store.unread_counts()
                    except Exception:
                        unread = {}
                    existing_ids = {t.get("id") for t in targets}
                    for cid in unread:
                        if cid in existing_ids:
                            continue
                        if _is_valid_aid(cid):
                            targets.append({"type": "peer", "id": cid, "name": _short_name(cid)})
                else:
                    unread = {}
                def _sort_key(t):
                    tid = t.get("id", "")
                    cnt = unread.get(tid, 0)
                    if cnt > 0:
                        return (0, -cnt)
                    try:
                        last_ts = self.cli_ref.store.last_message_time(tid) if self.cli_ref else 0
                    except Exception:
                        last_ts = 0
                    return (1, -(last_ts or 0))
                targets.sort(key=_sort_key)
                current_id = self.cli_ref.target.get("id") if self.cli_ref and self.cli_ref.target else None
                for t in targets:
                    tid = t.get("id", "")
                    tname = t.get("name", "")
                    is_current = " ✓" if tid == current_id else ""
                    cnt = unread.get(tid, 0)
                    unread_tag = f" (未读{cnt}条)" if cnt > 0 else ""
                    display = f"{tname}{unread_tag}{is_current}"
                    if target_filter and not (tname.lower().startswith(target_filter) or tid.lower().startswith(target_filter)):
                        continue
                    yield Completion(f"//target {tid}", start_position=-len(text),
                                     display=display, display_meta=tid)
                return

            for cmd, args, meta in _LOCAL_CMDS:
                cmd_bare = cmd.lstrip('/')
                display = f"{cmd} <{args}>" if args else cmd
                if cmd_bare.startswith(filter_text):
                    ct = cmd + " " if cmd_bare == filter_text else cmd
                    yield Completion(ct, start_position=-len(text),
                                     display=display, display_meta=meta)
                elif filter_text.startswith(cmd_bare) and (
                    len(filter_text) == len(cmd_bare) or filter_text[len(cmd_bare)] == ' '
                ):
                    yield Completion(text + " ", start_position=-len(text),
                                     display=display, display_meta=meta)
            return

        # / 前缀：group target → 群命令菜单，peer target → 远端命令菜单
        is_group = self.cli_ref and self.cli_ref.target and _is_group_target(self.cli_ref.target)
        if is_group:
            # 群命令补全
            filter_text = text[1:]
            if ' ' in filter_text:
                return
            is_owner = None
            if self.cli_ref:
                is_owner = self.cli_ref.is_current_group_owner_cached()
            for cmd_name, aliases, _desc, _need_group, _visible in _filter_group_commands_for_owner(is_owner):
                if not _visible:
                    continue
                matched = cmd_name.startswith(filter_text)
                if not matched:
                    matched = any(a.startswith(filter_text) for a in aliases)
                if matched:
                    ct = f"/{cmd_name} " if cmd_name == filter_text else f"/{cmd_name}"
                    yield Completion(ct, start_position=-len(text),
                                     display=f"/{cmd_name}", display_meta=_desc)
            # 始终提供本地命令入口
            if not filter_text or "".startswith(filter_text):
                yield Completion("//", start_position=-len(text),
                                 display="// 本地命令", display_meta="调试 · 设置")
            return
        # peer target → 远端命令菜单
        if text == "/" and self.cli_ref and not self.cli_ref._menu_querying and self.cli_ref.connected \
                and asyncio.get_event_loop().time() >= self.cli_ref._menu_cooldown_until:
            now = asyncio.get_event_loop().time()
            cache_expired = not self.cli_ref._pending_menu \
                or (now - self.cli_ref._menu_cached_at >= self.cli_ref._menu_ttl)
            if cache_expired:
                asyncio.ensure_future(self.cli_ref.query_menu())
        menu = self.cli_ref._pending_menu if self.cli_ref else None
        if not menu:
            if self.cli_ref and self.cli_ref._menu_querying:
                yield Completion("/", start_position=-len(text),
                                 display="加载中…", display_meta="等待远端响应")
            # 无论是否失败，都显示本地命令入口
            yield Completion("//", start_position=-len(text),
                             display="// 本地命令", display_meta="调试 · 设置")
            return
        filter_text = text[1:]  # / 后面的内容
        for group in menu:
            group_name = group['group']
            for cmd in group['commands']:
                cmd_text = cmd['cmd']
                args = cmd.get('args', '')
                label = cmd['label']
                cmd_bare = cmd_text.lstrip('/')
                display_text = "/" + cmd_bare
                display = f"{display_text} {args}".strip() if args else display_text
                meta_text = f"{group_name} · {label}"
                if cmd_bare.startswith(filter_text):
                    ct = display_text + " " if cmd_bare == filter_text else display_text
                    yield Completion(ct, start_position=-len(text),
                                     display=display, display_meta=meta_text)
                elif filter_text.startswith(cmd_bare) and (
                    len(filter_text) == len(cmd_bare) or filter_text[len(cmd_bare)] == ' '
                ):
                    yield Completion(text + " ", start_position=-len(text),
                                     display=display, display_meta=meta_text)

# 快捷键绑定
_kb = KeyBindings()

# Ctrl+C 双击退出 / 有任务时中断
_ctrlc_state = {'last': 0.0, 'hint': None, 'timer': None, 'session': None, '_cli': None}

def _clear_ctrlc_hint():
    _ctrlc_state['hint'] = None
    _ctrlc_state['timer'] = None
    if _ctrlc_state['session']:
        _ctrlc_state['session'].app.invalidate()

@_kb.add('c-c')
def _on_ctrlc(event):
    buf = event.current_buffer
    cli = _ctrlc_state.get('_cli')
    # 有处理中任务：单击 Ctrl+C 发送 /stop
    if cli and cli._processing:
        label = _target_label(cli.target) if cli.target else "?"
        print_status(label, "!", C.YELLOW, "正在中断…")
        asyncio.ensure_future(cli.send("/stop", encrypt=cli.encrypt, silent=True))
        return
    # 无任务：清空输入 / 双击退出
    if buf.text:
        buf.reset()
        return
    now = asyncio.get_event_loop().time()
    if now - _ctrlc_state['last'] < 1.5:
        event.app.exit(exception=EOFError())
        return
    _ctrlc_state['last'] = now
    _ctrlc_state['hint'] = "再按一次 Ctrl+C 退出"
    event.app.invalidate()
    if _ctrlc_state['timer']:
        _ctrlc_state['timer'].cancel()
    _ctrlc_state['timer'] = asyncio.get_event_loop().call_later(1.5, _clear_ctrlc_hint)

# Enter 键：补全菜单打开时只应用补全；空输入不提交
@_kb.add('enter')
def _enter(event):
    buf = event.current_buffer
    if buf.complete_state:
        comp = buf.complete_state.current_completion
        if comp is None:
            buf.cancel_completion()
            if buf.text.strip():
                buf.validate_and_handle()
            return
        buf.apply_completion(comp)
        text = buf.text
        # 子菜单触发器："//"，重新打开补全
        if text == '//':
            buf.start_completion()
            return
        # @切换目标 子菜单触发器：重新打开补全显示目标列表
        if text == '@切换目标 ':
            buf.start_completion()
            return
        # @aid 补全后保留光标，等待用户输入消息（或直接 Enter 仅切换目标）
        if text.startswith('@') and text.endswith(' ') and ' ' not in text.strip():
            buf.cancel_completion()
            return
        # 非子菜单：strip 尾部空格后提交
        stripped = text.rstrip()
        if stripped:
            buf.cancel_completion()
            buf.set_document(Document(stripped, len(stripped)))
            buf.validate_and_handle()
        return
    if buf.text.strip():
        buf.validate_and_handle()

# Ctrl+L：清屏（修复窗口缩放后的空白行问题）
@_kb.add('c-l')
def _clear_screen(event):
    event.app.renderer.clear()
    event.app.invalidate()

# 右箭头：补全菜单打开时不移动光标
@_kb.add('right')
def _right_arrow(event):
    buf = event.current_buffer
    if buf.complete_state:
        return  # 菜单打开时屏蔽光标移动
    buf.cursor_right()

# 左箭头：一级菜单退出并清空；二级菜单返回一级；无菜单时正常移动光标
@_kb.add('left')
def _left_arrow(event):
    buf = event.current_buffer
    if buf.complete_state:
        text = buf.text.strip()
        # 检测二级菜单：当前输入是本地命令（// 前缀）
        is_submenu = text.startswith('//')
        if is_submenu:
            # 本地菜单 → 返回远端菜单（/）
            buf.cancel_completion()
            buf.set_document(Document('/', 1))
            buf.start_completion()
        else:
            # 一级菜单 → 退出并清空
            buf.cancel_completion()
            buf.set_document(Document(''))
        return
    buf.cursor_left()

# Backspace：删除字符后，如果剩余文本以 / 开头，重新打开补全菜单
@_kb.add('backspace')
def _backspace(event):
    buf = event.current_buffer
    buf.delete_before_cursor(1)
    text = buf.text.strip()
    if text and text[0] in ('/', '@'):
        buf.start_completion()

# Ctrl+J：插入换行符（多行输入，macOS/Linux 通用）
@_kb.add('c-j')
def _newline(event):
    event.current_buffer.insert_text('\n')

# Escape：补全菜单打开时关闭菜单并清空输入
@_kb.add('escape', eager=True)
def _escape(event):
    buf = event.current_buffer
    if buf.complete_state:
        buf.cancel_completion()
        buf.set_document(Document(''))

# Ctrl+R：打开 Raw Data Monitor
@_kb.add('c-r')
def _open_rawdata(event):
    cli = _ctrlc_state.get('_cli')
    if cli:
        asyncio.ensure_future(cli.cmd_rawdata())

# Ctrl+D：toggle debug 模式（阻止 EOF 退出）
@_kb.add('c-d')
def _toggle_debug(event):
    cli = _ctrlc_state.get('_cli')
    if cli:
        cli.cmd_debug()

# Ctrl+G：toggle 数据日志
@_kb.add('c-g')
def _toggle_log(event):
    cli = _ctrlc_state.get('_cli')
    if cli:
        cli.cmd_log()

# ── 颜色输出 ──────────────────────────────────────────────────────────────

class C:
    CYAN   = "\033[36m"
    GREEN  = "\033[92m"
    YELLOW = "\033[93m"
    RED    = "\033[91m"
    WHITE  = "\033[97m"
    DIM    = "\033[2m"
    BOLD   = "\033[1m"
    RESET  = "\033[0m"

def _p(s):
    print_formatted_text(ANSI(s), color_depth=ColorDepth.TRUE_COLOR)

# ── Markdown 渲染 ─────────────────────────────────────────────────────────

# Markdown 特征：至少包含一个 Markdown 语法元素才走 rich 渲染
_MD_HINT_RE = re.compile(
    r'(?m)'
    r'(?:^#{1,6}\s)'          # heading
    r'|(?:\*\*.+?\*\*)'       # bold
    r'|(?:`.+?`)'             # inline code
    r'|(?:^```)'              # code fence
    r'|(?:^[-*+]\s)'          # unordered list
    r'|(?:^\d+\.\s)'          # ordered list
    r'|(?:^\|.+\|$)'          # table
    r'|(?:^>\s)'              # blockquote
)

_RICH_THEME = RichTheme({"code": "green", "markdown.code": "green"})
_MULTI_NL_RE = re.compile(r'\n{3,}')

# Emoji 短码替换（:smile: → 😄）
from rich._emoji_codes import EMOJI as _EMOJI_CODES
_EMOJI_RE = re.compile(r':([a-z0-9_+-]+):')

def _replace_emoji(text: str) -> str:
    return _EMOJI_RE.sub(lambda m: _EMOJI_CODES.get(m.group(1), m.group(0)), text)

def _render_md(text: str) -> str:
    """Markdown → ANSI string via rich. 非 Markdown 文本原样返回。"""
    if not _MD_HINT_RE.search(text):
        return text
    try:
        buf = StringIO()
        console = RichConsole(
            file=buf, force_terminal=True, color_system="truecolor",
            width=max(40, _termwidth() - 4), theme=_RICH_THEME,
            highlight=False, no_color=False,
        )
        console.print(RichMarkdown(text, hyperlinks=False), end="")
        rendered = buf.getvalue().rstrip('\n')
        # rich 段落间会插空行，压缩连续空行为单个
        rendered = _MULTI_NL_RE.sub('\n\n', rendered)
        return rendered
    except Exception:
        return text

# ──────────────────────────────────────────────────────────────────────────

def _termwidth():
    try:
        return os.get_terminal_size().columns
    except OSError:
        return 80

def _sys(icon, color, msg):
    ts = datetime.now().strftime('%H:%M:%S')
    content = f"{C.DIM}{ts}\033[22m {color}{icon}\033[39m {msg}"
    _p(content)

def info(msg):  _sys("·", C.CYAN, msg)
def error(msg): _sys("✗", C.RED, msg)

def print_recv(from_aid, text, extra=""):
    name = _short_name(from_aid)
    ts = datetime.now().strftime('%H:%M:%S')
    text = _replace_emoji(text)
    rendered = _render_md(text)
    lines = rendered.rstrip().split('\n')
    if len(lines) > 1:
        header = f"{C.DIM}{ts}\033[22m {C.GREEN}◀ {name}\033[39m"
        _p(header)
        for i, line in enumerate(lines):
            content = line + (extra if i == len(lines) - 1 else "")
            _p(content)
    else:
        first = f"{C.DIM}{ts}\033[22m {C.GREEN}◀ {name}\033[39m  {lines[0]}{extra}"
        _p(first)

def print_status(from_aid, icon, color, text):
    name = _short_name(from_aid)
    ts = datetime.now().strftime('%H:%M:%S')
    content = f"{C.DIM}{ts}\033[22m {color}{icon} {name}\033[39m  {C.DIM}{text}\033[22m"
    _p(content)

# ── 消息持久化 ─────────────────────────────────────────────────────────────

class MessageStore:
    """SQLite 消息存储（WAL 模式，懒初始化）。"""

    def __init__(self, db_path: str):
        self._db_path = db_path
        self._conn = None

    def _ensure(self):
        if self._conn is not None:
            return
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id      TEXT UNIQUE,
                conversation_id TEXT NOT NULL,
                conversation_type TEXT NOT NULL,
                direction       TEXT NOT NULL,
                sender          TEXT NOT NULL,
                payload         TEXT NOT NULL,
                seq             INTEGER,
                timestamp       INTEGER NOT NULL,
                is_read         INTEGER NOT NULL DEFAULT 0
            )
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_conv_unread
            ON messages (conversation_id, is_read)
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_conv_ts
            ON messages (conversation_id, timestamp)
        """)
        self._conn.commit()

    def save(self, message_id, conversation_id, conversation_type,
             direction, sender, payload, seq, timestamp, is_read):
        self._ensure()
        try:
            self._conn.execute(
                """INSERT OR IGNORE INTO messages
                   (message_id, conversation_id, conversation_type,
                    direction, sender, payload, seq, timestamp, is_read)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (message_id, conversation_id, conversation_type,
                 direction, sender, payload, seq, timestamp, is_read),
            )
            self._conn.commit()
        except Exception:
            pass

    def mark_read(self, conversation_id):
        self._ensure()
        self._conn.execute(
            "UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND is_read = 0",
            (conversation_id,),
        )
        self._conn.commit()

    def get_unread(self, conversation_id, limit=50):
        self._ensure()
        cur = self._conn.execute(
            """SELECT id, message_id, conversation_id, conversation_type,
                      direction, sender, payload, seq, timestamp
               FROM messages
               WHERE conversation_id = ? AND is_read = 0
               ORDER BY timestamp ASC LIMIT ?""",
            (conversation_id, limit),
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def get_history(self, conversation_id, limit=20, before_id=None):
        self._ensure()
        if before_id is not None:
            cur = self._conn.execute(
                """SELECT id, message_id, conversation_id, conversation_type,
                          direction, sender, payload, seq, timestamp, is_read
                   FROM messages
                   WHERE conversation_id = ? AND id < ?
                   ORDER BY timestamp DESC LIMIT ?""",
                (conversation_id, before_id, limit),
            )
        else:
            cur = self._conn.execute(
                """SELECT id, message_id, conversation_id, conversation_type,
                          direction, sender, payload, seq, timestamp, is_read
                   FROM messages
                   WHERE conversation_id = ?
                   ORDER BY timestamp DESC LIMIT ?""",
                (conversation_id, limit),
            )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        rows.reverse()
        return rows

    def unread_counts(self):
        self._ensure()
        cur = self._conn.execute(
            """SELECT conversation_id, COUNT(*)
               FROM messages WHERE is_read = 0
               GROUP BY conversation_id"""
        )
        return dict(cur.fetchall())

    def unread_total(self, exclude=None):
        counts = self.unread_counts()
        if exclude:
            counts.pop(exclude, None)
        return sum(counts.values())

    def exists(self, message_id):
        """检查 message_id 是否已存在。"""
        if not message_id:
            return False
        self._ensure()
        cur = self._conn.execute(
            "SELECT 1 FROM messages WHERE message_id = ? LIMIT 1",
            (message_id,),
        )
        return cur.fetchone() is not None

    def last_message_time(self, conversation_id):
        self._ensure()
        cur = self._conn.execute(
            "SELECT MAX(timestamp) FROM messages WHERE conversation_id = ?",
            (conversation_id,),
        )
        row = cur.fetchone()
        return row[0] if row else None

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

# ── 文件收发工具函数 ──────────────────────────────────────────────────────

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB（storage 协议限制）
INLINE_THRESHOLD = 64 * 1024       # ≤64KB 使用 inline 上传

def _sanitize_filename(name: str) -> str:
    """清理文件名：去除路径遍历字符、替换非法字符。"""
    # 去除路径分隔符
    name = name.replace("/", "_").replace("\\", "_")
    # 去除前导点（隐藏文件 / 目录遍历）
    name = name.lstrip(".")
    # 替换非法字符（保留中文、字母、数字、点、连字符、下划线）
    name = re.sub(r'[<>:"|?*\x00-\x1f]', '_', name)
    return name or "unnamed"

def _hash_file(path: Path, algo: str = "sha256") -> str:
    """计算文件哈希值（默认 SHA-256）。"""
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()

def _format_size(size_bytes: int) -> str:
    """格式化文件大小。"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"

def _guess_mime(path: Path) -> str:
    """猜测文件 MIME 类型。"""
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"

def _save_to_downloads(data: bytes, filename: str, sender_aid: str) -> Path:
    """保存下载的文件到本地目录，支持 MD5 去重。

    目录结构: DOWNLOADS_DIR / {sender_short_name} / {filename}
    同名同内容复用已有文件，同名不同内容加时间戳后缀。
    """
    sender_dir = DOWNLOADS_DIR / _short_name(sender_aid)
    sender_dir.mkdir(parents=True, exist_ok=True)

    safe_name = _sanitize_filename(filename)
    target_path = sender_dir / safe_name

    # 计算新文件 MD5
    new_md5 = hashlib.md5(data).hexdigest()

    if target_path.exists():
        # 同名文件已存在 — 检查内容
        existing_md5 = hashlib.md5(target_path.read_bytes()).hexdigest()
        if existing_md5 == new_md5:
            return target_path  # 同名同内容，复用
        # 同名不同内容 — 加时间戳后缀
        stem = target_path.stem
        suffix = target_path.suffix
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        safe_name = f"{stem}_{ts}{suffix}"
        target_path = sender_dir / safe_name

    target_path.write_bytes(data)
    return target_path

# ── 客户端 ────────────────────────────────────────────────────────────────

class AUNCli:
    def __init__(self, aid=None, target=None):
        cfg = _load_config()
        self.my_aid     = aid or cfg.get("aid")
        # target 统一为 dict: {"type": "peer"|"group", "id": str, "name": str}
        raw_target = target or cfg.get("target")
        self.target     = _normalize_target(raw_target)
        self.client     = None
        self.connected  = False
        self.msg_count  = 0
        self.last_e2ee  = ""       # 最近一条消息的加密状态
        self.encrypt    = cfg.get("encrypt", True)   # 当前发送模式：True=E2EE, False=明文（不影响接收，接收始终兼容两种形态）
        self.plaintext_recv = 0    # 安全审计：E2EE 模式下收到的明文消息数
        self._last_sent = None     # 最近发送时间
        self._last_sent_seq = None # 最近发送的 seq
        self._processing = set()   # 正在处理中的 sessionId 集合
        self._proc_start = {}      # sessionId → 开始时间（event loop time）
        # spinner 动态提示
        self._spinner_task = None       # asyncio.Task for _spinner_loop
        self._spinner_aid = None        # 当前处理中的 AID (None=不显示)
        self._spinner_frame = 0         # 当前帧索引
        self._spinner_elapsed = 0       # 已运行秒数
        self._spinner_session = None    # PromptSession 引用（供 invalidate）
        # debug 菜单
        self.debug_mode = cfg.get("debug", False)
        self._last_e2ee_event = None    # /e2ee 用 {type, data, time}
        self._e2ee_restore_timer = None # token.refreshed 3秒恢复定时器
        self._pending_menu = None       # menu.response 缓存（成功后保留）
        self._menu_fresh = False        # 标记本轮查询是否收到新响应
        self._menu_querying = False     # 菜单查询进行中标记
        self._menu_failures = 0         # 连续菜单查询失败次数
        self._menu_cooldown_until = 0   # 菜单冷却截止时间（event loop time）
        self._menu_cached_at = 0        # 缓存写入时间（event loop time）
        self._menu_ttl = 300            # 缓存有效期（秒，默认 5 分钟）
        self._suppress_next = False     # silent send 时抑制下一条回复
        self._raw_log = []              # rawdata 条目缓冲 (每条是一个 dict: {ts, data})
        self._raw_monitor_app = None    # 活跃的监控 Application 引用
        # 重连退避
        self._reconn_failures = 0       # 连续重连失败次数
        self._reconn_cooldown_until = 0 # 冷却截止时间（event loop time）
        # 群缓存
        self._group_cache = []          # group.list_my 结果
        self._group_cache_at = 0        # 缓存写入时间
        self._group_cache_ttl = 300     # 缓存有效期（秒）
        self._group_cache_refreshing = False
        # 群成员缓存
        self._members_cache = {}        # group_id → [{"aid": ..., "role": ...}, ...]
        self._members_cache_at = {}     # group_id → timestamp
        self._members_cache_ttl = 300   # 缓存有效期（秒）
        # 数据日志
        self._log_enabled = cfg.get("log", False)  # 从 config 恢复
        self._log_file = None           # 日志文件句柄
        self._log_date = None           # 当前日志文件对应的日期字符串
        # 消息持久化
        self.store = MessageStore(str(DATA_DIR / "messages.db"))

    async def start(self):
        """用 self.my_aid 启动，AID 不存在则报错退出。"""
        aid = self.my_aid

        self.client = _make_client()
        self.client._gateway_url = GATEWAY_URL
        self.client.on("message.received", self._on_message)
        self.client.on("connection.state",  self._on_state)
        self.client.on("message.ack",       self._on_ack)
        self.client.on("token.refreshed",   self._on_token_refreshed)
        self.client.on("e2ee.degraded",     self._on_e2ee_degraded)
        self.client.on("e2ee.orchestration_error", self._on_e2ee_error)
        self.client.on("group.message_created", self._on_group_message)
        self.client.on("group.changed",     self._on_group_changed)

        from aun_core import __version__ as _sdk_ver
        info(f"AID: {C.BOLD}{aid}{C.RESET}  {C.DIM}(aun-core {_sdk_ver}){C.RESET}")

        local = _get_keystore().load_identity(aid)
        if local is None:
            error(f"AID {aid} 不存在，请先用 aun aid new <name> 创建")
            raise SystemExit(1)
        if "private_key_pem" not in (local or {}):
            error(f"AID {aid} 私钥丢失，请删除后重新创建")
            raise SystemExit(1)

        info("已有本地身份")
        info("正在认证…")
        auth = await self.client.auth.authenticate({"aid": aid})
        info(f"认证成功  gateway: {auth.get('gateway')}")

        info("正在连接网关…")
        await self.client.connect({
            "access_token": auth["access_token"],
            "gateway":      auth["gateway"],
            "auto_reconnect": True,
        })
        self.connected = True
        self._connected_at = time.monotonic()
        # 连接成功后持久化 AID
        cfg = _load_config()
        cfg["aid"] = self.my_aid
        _save_config(cfg)
        info(f"{C.GREEN}已连接{C.RESET}  AID = {self.client.aid}")
        # 恢复数据日志
        if self._log_enabled and not self._log_file:
            self._open_log_file()
        if self.target:
            info(f"目标: {_target_label(self.target)}")
            _record_target(self.target)
            # 连接成功后预加载远端菜单（仅 peer target）
            if _is_peer_target(self.target):
                asyncio.ensure_future(self.query_menu())
            # 预加载当前群的成员缓存
            if _is_group_target(self.target):
                asyncio.ensure_future(self._ensure_members_cache(self.target["id"]))
            # 后台刷新群缓存
            asyncio.ensure_future(self._refresh_group_cache())

    # ── Spinner 动画 ──────────────────────────────────────────────────────

    _SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")

    def _start_spinner(self, aid: str):
        """启动 spinner：记录 AID 并启动刷新循环。"""
        name = _short_name(aid)
        self._spinner_aid = name
        self._spinner_frame = 0
        self._spinner_elapsed = 0
        if self._spinner_task is None or self._spinner_task.done():
            self._spinner_task = asyncio.ensure_future(self._spinner_loop())

    def _stop_spinner(self):
        """停止 spinner：清除状态，触发最后一次重绘去掉 spinner 行。"""
        self._spinner_aid = None
        if self._spinner_task and not self._spinner_task.done():
            self._spinner_task.cancel()
            self._spinner_task = None
        # 触发重绘以移除 spinner 行
        if self._spinner_session and self._spinner_session.app:
            self._spinner_session.app.invalidate()

    async def _spinner_loop(self):
        """每 100ms 更新帧，每秒递增计时，通过 app.invalidate() 触发重绘。"""
        ticks = 0  # 100ms 计数器
        try:
            while self._spinner_aid:
                await asyncio.sleep(0.1)
                ticks += 1
                self._spinner_frame = (self._spinner_frame + 1) % len(self._SPINNER_FRAMES)
                if ticks % 10 == 0:
                    self._spinner_elapsed += 1
                if self._spinner_session and self._spinner_session.app:
                    self._spinner_session.app.invalidate()
        except asyncio.CancelledError:
            pass

    # ─────────────────────────────────────────────────────────────────────

    def _handle_status_payload(self, payload, from_aid, conversation_id=None) -> bool:
        """处理 processing / menu 状态消息。返回 True 表示已消费，调用方应 return。
        conversation_id: 用于判断是否为当前 target 的会话 ID（peer AID 或 group ID）。
        缺省时回退到 from_aid。"""
        proc_payload = payload
        if isinstance(proc_payload, str):
            try:
                proc_payload = json.loads(proc_payload)
            except (json.JSONDecodeError, TypeError):
                return False
        if not isinstance(proc_payload, dict):
            return False

        msg_type = proc_payload.get("type")

        if msg_type == "processing":
            conv_id = conversation_id or from_aid
            is_current = self.target and self.target.get("id") == conv_id
            # 非当前 target → 静默消费
            if not is_current:
                return True
            # 连接后 3 秒内的 processing 是 Gateway pull 回来的历史状态，静默丢弃
            if hasattr(self, '_connected_at') and (time.monotonic() - self._connected_at) < 3:
                return True
            sid = proc_payload.get("sessionId", "?")
            status = proc_payload.get("status", "")
            if status == "start":
                self._processing.add(sid)
                self._proc_start[sid] = asyncio.get_event_loop().time()
                if self.debug_mode and self._last_sent is not None:
                    delay_ms = int((asyncio.get_event_loop().time() - self._last_sent) * 1000)
                    print_status(from_aid, "▶", C.CYAN, f"开始处理 ({delay_ms}ms)")
                else:
                    print_status(from_aid, "▶", C.CYAN, "开始处理")
                self._start_spinner(from_aid)
            elif status == "done":
                self._stop_spinner()
                self._processing.discard(sid)
                start_t = self._proc_start.pop(sid, None)
                if start_t is not None:
                    secs = int(asyncio.get_event_loop().time() - start_t)
                    if secs >= 60:
                        elapsed_str = f"处理完成，耗时{secs//60}分{secs%60}秒"
                    else:
                        elapsed_str = f"处理完成，耗时{secs}秒"
                else:
                    elapsed_str = "处理完成"
                print_status(from_aid, "*", C.GREEN, elapsed_str)
            elif status == "interrupted":
                self._stop_spinner()
                self._processing.discard(sid)
                start_t = self._proc_start.pop(sid, None)
                if self.debug_mode and start_t is not None:
                    secs = int(asyncio.get_event_loop().time() - start_t)
                    print_status(from_aid, "!", C.YELLOW, f"已中断，耗时{secs}秒")
                else:
                    print_status(from_aid, "!", C.YELLOW, "已中断")
            elif status == "timeout":
                self._stop_spinner()
                self._processing.discard(sid)
                self._proc_start.pop(sid, None)
                print_status(from_aid, "!", C.RED, "处理超时")
            elif status == "error":
                self._stop_spinner()
                self._processing.discard(sid)
                self._proc_start.pop(sid, None)
                print_status(from_aid, "x", C.RED, "处理失败")
            return True

        if msg_type == "menu.response":
            self._pending_menu = proc_payload.get("items", [])
            self._menu_cached_at = asyncio.get_event_loop().time()
            self._menu_fresh = True
            return True

        if msg_type == "menu.query":
            return True

        return False

    async def _on_message(self, data):
        if not isinstance(data, dict):
            return
        from_aid = data.get("from", "?")
        payload  = data.get("payload", "")
        task_id  = data.get("task_id", "")
        e2ee     = data.get("e2ee", {})

        # 记录到 raw log（供监控台显示）
        # 非 debug: 保留最近 5 条；debug: 保留最近 20 条；监控台打开时无上限累积（滑动窗口 500 条）
        ts = datetime.now().strftime('%H:%M:%S')
        entry = f"[{ts}] {json.dumps(data, ensure_ascii=False, default=str)}"
        self._raw_log.append(entry)
        if self._raw_monitor_app is not None:
            cap = 500
        elif self.debug_mode:
            cap = 20
        else:
            cap = 5
        if len(self._raw_log) > cap:
            self._raw_log = self._raw_log[-cap:]
        if self._raw_monitor_app is not None:
            self._raw_monitor_app.invalidate()

        # 数据日志
        self._log_write("RECV", data)

        # processing / menu 状态通知
        if self._handle_status_payload(payload, from_aid):
            return

        text = payload.get("text", json.dumps(payload, ensure_ascii=False)) \
               if isinstance(payload, dict) else str(payload)

        # 更新最近消息的加密状态（供 /e2ee 调试命令使用）
        msg_encrypted = bool(e2ee)
        self.last_e2ee = "🔒 E2EE" if msg_encrypted else "🔓 明文"

        # 安全审计：本地处于 E2EE 模式但对方发来明文，仅记录计数，不拒收
        if self.encrypt and not msg_encrypted:
            self.plaintext_recv += 1

        self.msg_count += 1
        _record_target({"type": "peer", "id": from_aid, "name": _short_name(from_aid)})

        is_current = self.target and self.target.get("id") == from_aid

        # 非当前 target → 静默存储，不打印
        if not is_current:
            msg_id = data.get("message_id") or f"recv_{from_aid}_{int(time.time()*1000)}"
            self.store.save(
                message_id=msg_id,
                conversation_id=from_aid,
                conversation_type="peer",
                direction="recv",
                sender=from_aid,
                payload=text,
                seq=data.get("seq"),
                timestamp=int(time.time() * 1000),
                is_read=0,
            )
            # 附件仍需下载
            attachments = payload.get("attachments") if isinstance(payload, dict) else None
            if attachments and isinstance(attachments, list):
                asyncio.ensure_future(self._handle_attachments(attachments, from_aid))
            return

        # debug: 收到第一条回复数据时显示延迟
        if self.debug_mode and self._last_sent is not None:
            delay_ms = int((asyncio.get_event_loop().time() - self._last_sent) * 1000)
            print_status(from_aid, "·", C.DIM, f"准备输出 ({delay_ms}ms)")
            self._last_sent = None  # 只显示一次

        # silent send 抑制回复（如 Ctrl+C 中断的 /stop 响应）
        if self._suppress_next:
            self._suppress_next = False
            return

        # 去重：本地已有的消息跳过显示（Gateway pull 重复推送）
        # 未读消息已在 _show_unread() 切换 target 时批量展示
        msg_id = data.get("message_id")
        if msg_id and self.store.exists(msg_id):
            return

        extra = ""
        if task_id: extra += f"  {C.DIM}[task:{task_id}]\033[22m"

        print_recv(from_aid, text, extra)

        # 附件自动下载
        attachments = payload.get("attachments") if isinstance(payload, dict) else None
        if attachments and isinstance(attachments, list):
            asyncio.ensure_future(self._handle_attachments(attachments, from_aid))

        # 持久化消息
        if not msg_id:
            msg_id = f"recv_{from_aid}_{int(time.time()*1000)}"
        self.store.save(
            message_id=msg_id,
            conversation_id=from_aid,
            conversation_type="peer",
            direction="recv",
            sender=from_aid,
            payload=text,
            seq=data.get("seq"),
            timestamp=int(time.time() * 1000),
            is_read=1,
        )

    async def _on_state(self, data):
        if not isinstance(data, dict):
            return
        self._log_write("EVENT", {"type": "connection.state", **data})
        state = data.get("state", "")
        if state == "disconnected":
            self.connected = False
            error(f"连接断开: {data.get('error','unknown')}")
        elif state == "connected":
            self.connected = True
            self._connected_at = time.monotonic()
            info("重新连接成功")
            # 重连后刷新远端菜单（仅 peer target）
            if self.target and _is_peer_target(self.target):
                self._pending_menu = None
                asyncio.ensure_future(self.query_menu())

    async def _reconnect(self):
        """断线后尝试重新认证并连接，带指数退避冷却。"""
        now = asyncio.get_event_loop().time()
        # 冷却期内不重试
        if self._reconn_cooldown_until > now:
            remain = int(self._reconn_cooldown_until - now)
            error(f"未连接（{remain}秒后可重试）")
            return False
        info("正在重连…")
        try:
            # 先 close() 重置状态，否则 terminal_failed 下 connect() 会被拒绝
            await self.client.close()
            auth = await self.client.auth.authenticate({"aid": self.my_aid})
            await self.client.connect({
                "access_token": auth["access_token"],
                "gateway":      auth["gateway"],
                "auto_reconnect": True,
            })
            self.connected = True
            self._connected_at = time.monotonic()
            self._reconn_failures = 0
            self._reconn_cooldown_until = 0
            info(f"{C.GREEN}重连成功{C.RESET}")
            return True
        except Exception as e:
            self._reconn_failures += 1
            # 指数退避：5s, 10s, 20s, 40s, 最大 60s
            cooldown = min(5 * (2 ** (self._reconn_failures - 1)), 60)
            self._reconn_cooldown_until = now + cooldown
            error(f"重连失败: {e}（{cooldown}秒后可重试）")
            return False

    async def switch_aid(self, new_aid: str):
        """运行时切换 AID：断开 → 重新认证 → 连接。"""
        if new_aid == self.my_aid:
            info(f"当前已是 {new_aid}"); return
        local = _get_keystore().load_identity(new_aid)
        if local is None or "private_key_pem" not in (local or {}):
            error(f"AID {new_aid} 不存在或私钥丢失"); return
        info(f"正在切换到 {new_aid}…")
        try:
            await self.client.close()
            self.connected = False
            self.my_aid = new_aid
            auth = await self.client.auth.authenticate({"aid": new_aid})
            await self.client.connect({
                "access_token": auth["access_token"],
                "gateway":      auth["gateway"],
                "auto_reconnect": True,
            })
            self.connected = True
            self._connected_at = time.monotonic()
            self._reconn_failures = 0
            self._reconn_cooldown_until = 0
            if self.target and _is_group_target(self.target):
                await self._refresh_group_cache()
                await self._ensure_members_cache(self.target["id"], force=True)
            # 持久化为默认 AID
            cfg = _load_config()
            cfg["aid"] = new_aid
            _save_config(cfg)
            info(f"{C.GREEN}已切换{C.RESET}  AID = {new_aid}")
        except Exception as e:
            error(f"切换失败: {e}")

    async def send(self, text, encrypt=True, silent=False):
        if not self.client:
            error("未连接"); return
        if not self.connected:
            if not await self._reconnect():
                return
        if not self.target:
            error("未设置目标，使用 @aid 或 @group_id"); return
        if silent:
            self._suppress_next = True
        target_id = self.target["id"]
        target_label = _target_label(self.target)
        try:
            t0 = asyncio.get_event_loop().time()
            if _is_group_target(self.target):
                result = await self.client.call("group.send", {
                    "group_id": target_id,
                    "payload": {"text": text},
                    "type": "text",
                    "encrypt": encrypt,
                })
            else:
                result = await self.client.call("message.send", {
                    "to": target_id, "payload": text,
                    "encrypt": encrypt,
                })
            self._last_sent = asyncio.get_event_loop().time()
            self._last_sent_seq = result.get("seq") if isinstance(result, dict) else None
            _record_target(self.target)
            # 数据日志
            send_log = {
                "to": target_id, "text": text, "encrypt": encrypt,
                "result": _strip_send_result(result),
            }
            self._log_write("SEND", send_log)
            status = result.get("status") if isinstance(result, dict) else None
            label = "已送达" if status == "delivered" else "已发送"
            if self.debug_mode:
                ms = int((self._last_sent - t0) * 1000)
                print_status(target_label, "▶", C.YELLOW, f"{label} ({ms}ms)")
            # 发新消息时清理旧的 processing 状态
            self._processing.clear()
            if text != '/stop':
                self._proc_start.clear()
            # 持久化已发消息
            conv_type = "group" if _is_group_target(self.target) else "peer"
            msg_id = (result.get("message_id") if isinstance(result, dict) else None) \
                     or f"sent_{target_id}_{int(time.time()*1000)}"
            self.store.save(
                message_id=msg_id,
                conversation_id=target_id,
                conversation_type=conv_type,
                direction="sent",
                sender=self.my_aid,
                payload=text,
                seq=None,
                timestamp=int(time.time() * 1000),
                is_read=1,
            )
        except asyncio.TimeoutError:
            self._suppress_next = False
            print_status(target_label, "x", C.RED, "发送超时")
        except Exception as e:
            self._suppress_next = False
            if _is_group_target(self.target) and _is_group_not_joined_error(e):
                print_status(target_label, "x", C.RED, f"发送失败: 你当前不在群 {target_label}，请先加入群组")
                return
            print_status(target_label, "x", C.RED, f"发送失败: {e}")

    async def send_file(self, file_path_str: str):
        """发送文件到当前 target。

        流程:
        1. 校验文件存在、可读、大小限制
        2. 计算 sha256 / size / mime
        3. 上传到 storage（inline ≤64KB，ticket >64KB）
        4. 构造附件 payload 发消息
        """
        import aiohttp

        if not self.client:
            error("未连接"); return
        if not self.connected:
            if not await self._reconnect():
                return
        if not self.target:
            error("未设置目标，使用 @aid 或 @group_id"); return

        # 1. 校验文件
        file_path = Path(file_path_str).expanduser().resolve()
        if not file_path.exists():
            error(f"文件不存在: {file_path}"); return
        if not file_path.is_file():
            error(f"不是文件: {file_path}"); return

        file_size = file_path.stat().st_size
        if file_size == 0:
            error("文件为空"); return
        if file_size > MAX_FILE_SIZE:
            error(f"文件过大: {_format_size(file_size)}（上限 {_format_size(MAX_FILE_SIZE)}）"); return

        filename = file_path.name
        content_type = _guess_mime(file_path)
        sha256 = _hash_file(file_path, "sha256")
        object_key = f"shared/{uuid.uuid4()}/{filename}"

        target_id = self.target["id"]
        target_label = _target_label(self.target)
        info(f"📎 发送文件: {filename} ({_format_size(file_size)})")

        try:
            # 2. 上传到 storage
            if file_size <= INLINE_THRESHOLD:
                # inline 上传
                file_data = file_path.read_bytes()
                content_b64 = base64.b64encode(file_data).decode()
                result = await self.client.call("storage.put_object", {
                    "object_key": object_key,
                    "content": content_b64,
                    "content_type": content_type,
                    "is_private": False,
                    "overwrite": True,
                })
                if self.debug_mode:
                    info(f"  inline 上传完成: {result.get('object_key')}")
            else:
                # ticket 上传
                file_data = file_path.read_bytes()
                session_result = await self.client.call("storage.create_upload_session", {
                    "object_key": object_key,
                    "size_bytes": file_size,
                    "content_type": content_type,
                })
                upload_url = session_result["upload_url"]
                if self.debug_mode:
                    info(f"  upload session 创建完成，正在上传…")

                async with aiohttp.ClientSession() as http:
                    async with http.put(upload_url, data=file_data) as resp:
                        if resp.status not in (200, 201):
                            error(f"HTTP 上传失败: {resp.status}")
                            return

                result = await self.client.call("storage.complete_upload", {
                    "object_key": object_key,
                    "sha256": sha256,
                    "content_type": content_type,
                    "is_private": False,
                    "size_bytes": file_size,
                })
                if self.debug_mode:
                    info(f"  ticket 上传完成: {result.get('object_key')}")

            # 3. 构造附件 payload
            attachment = {
                "owner_aid": self.my_aid,
                "object_key": object_key,
                "filename": filename,
                "size": file_size,
                "sha256": sha256,
                "content_type": content_type,
            }
            payload = {
                "text": f"📎 {filename} ({_format_size(file_size)})",
                "attachments": [attachment],
            }

            # 4. 发消息
            if _is_group_target(self.target):
                msg_result = await self.client.call("group.send", {
                    "group_id": target_id,
                    "payload": payload,
                    "type": "file",
                    "encrypt": self.encrypt,
                })
            else:
                msg_result = await self.client.call("message.send", {
                    "to": target_id,
                    "payload": payload,
                    "type": "file",
                    "encrypt": self.encrypt,
                })

            self._last_sent = asyncio.get_event_loop().time()
            _record_target(self.target)
            self._log_write("SEND_FILE", {
                "to": target_id, "filename": filename,
                "size": file_size, "object_key": object_key,
                "result": _strip_send_result(msg_result),
            })
            print_status(target_label, "▶", C.YELLOW, f"📎 {filename} 已发送")

            # 持久化
            conv_type = "group" if _is_group_target(self.target) else "peer"
            msg_id = (msg_result.get("message_id") if isinstance(msg_result, dict) else None) \
                     or f"sent_{target_id}_{int(time.time()*1000)}"
            self.store.save(
                message_id=msg_id,
                conversation_id=target_id,
                conversation_type=conv_type,
                direction="sent",
                sender=self.my_aid,
                payload=payload.get("text", ""),
                seq=None,
                timestamp=int(time.time() * 1000),
                is_read=1,
            )

        except asyncio.TimeoutError:
            print_status(target_label, "x", C.RED, "文件发送超时")
        except Exception as e:
            print_status(target_label, "x", C.RED, f"文件发送失败: {e}")

    async def _handle_attachments(self, attachments: list, from_aid: str):
        """下载附件并保存到本地。

        对每个附件:
        1. 调 create_download_ticket 获取一次性下载 URL
        2. HTTP GET 下载
        3. sha256 校验
        4. 保存到 DOWNLOADS_DIR / {sender_short_name} /
        """
        import aiohttp

        for att in attachments:
            owner_aid = att.get("owner_aid", from_aid)
            object_key = att.get("object_key", "")
            filename = att.get("filename", object_key.rsplit("/", 1)[-1] or "unknown")
            expected_size = att.get("size", 0)
            expected_sha = att.get("sha256", "")
            content_type = att.get("content_type", "")

            size_str = _format_size(expected_size) if expected_size else "?"
            info(f"  📥 {filename} ({size_str})")

            try:
                # 获取下载 ticket
                ticket = await self.client.call("storage.create_download_ticket", {
                    "owner_aid": owner_aid,
                    "object_key": object_key,
                })
                download_url = ticket.get("download_url", "")
                if not download_url:
                    error(f"    下载失败: 未获取到下载 URL")
                    continue

                # HTTP GET 下载
                async with aiohttp.ClientSession() as http:
                    async with http.get(download_url) as resp:
                        if resp.status != 200:
                            error(f"    下载失败: HTTP {resp.status}")
                            continue
                        data = await resp.read()

                # sha256 校验
                if expected_sha:
                    actual_sha = hashlib.sha256(data).hexdigest()
                    if actual_sha != expected_sha:
                        error(f"    文件校验失败（期望 {expected_sha[:8]}…，实际 {actual_sha[:8]}…）")
                        continue

                # 保存到本地
                saved_path = _save_to_downloads(data, filename, from_aid)
                info(f"    ✅ 已保存: {saved_path}")

            except Exception as e:
                error(f"    📥 {filename} 下载失败: {e}")
                # 不阻塞其他附件

    async def query_menu(self, manual=False):
        """查询远端菜单并缓存到 _pending_menu（供 AUNCompleter 读取）。
        已有缓存时跳过，除非 manual=True 强制刷新。仅 peer target 生效。"""
        if not self.client or not self.connected:
            if manual: error("未连接")
            return False
        if not self.target or not _is_peer_target(self.target):
            if manual: error("仅对 peer 目标有效")
            return False
        target_id = self.target["id"]
        if self._menu_querying:
            if manual: info("菜单查询中…")
            return False
        # 已有缓存、未过期、非手动刷新 → 跳过
        now = asyncio.get_event_loop().time()
        cache_valid = self._pending_menu and (now - self._menu_cached_at < self._menu_ttl)
        if cache_valid and not manual:
            return True
        self._menu_querying = True
        self._menu_fresh = False        # 重置，等待新响应
        send_status = None              # message.send 响应中的 status
        try:
            result = await self.client.call("message.send", {
                "to": target_id,
                "payload": json.dumps({"type": "menu.query"}),
                "encrypt": True,
            })
            if isinstance(result, dict):
                send_status = result.get("status")
        except Exception as e:
            self._menu_querying = False
            self._menu_failures += 1
            cooldown = min(5 * (2 ** (self._menu_failures - 1)), 60)
            self._menu_cooldown_until = asyncio.get_event_loop().time() + cooldown
            if manual: error(f"菜单查询失败: {e}")
            return False
        if manual: info("菜单查询已发送，等待响应…")
        # 后台等待响应
        asyncio.ensure_future(self._wait_menu_response(manual, send_status))

    async def _wait_menu_response(self, manual=False, send_status=None):
        """后台等待 menu.response，超时后根据 send_status 给出提示。"""
        for _ in range(50):
            if self._menu_fresh:
                break
            await asyncio.sleep(0.1)
        self._menu_querying = False
        if self._menu_fresh:
            self._menu_failures = 0
            self._menu_cooldown_until = 0
            if manual:
                count = sum(len(g.get("commands", [])) for g in self._pending_menu)
                info(f"已加载 {count} 条远端命令")
        else:
            self._menu_failures += 1
            cooldown = min(5 * (2 ** (self._menu_failures - 1)), 60)
            self._menu_cooldown_until = asyncio.get_event_loop().time() + cooldown
            if manual:
                if send_status == "delivered":
                    info("对端不支持菜单查询")
                elif send_status == "sent":
                    info("对端不在线")
                else:
                    info("菜单查询超时")

    async def ping(self):
        if not self.client:
            error("未连接"); return
        try:
            result = await self.client.ping()
            info(f"Ping: {result}")
        except Exception as e:
            error(f"Ping 失败: {e}")

    async def status(self):
        conn = "🟢 已连接" if self.connected else "🔴 未连接"
        sdk = self.client.state if self.client else "N/A"
        tgt = _target_label(self.target) if self.target else "(未设置)"
        lines = (
            f'  我的 AID:   {self.my_aid}\n'
            f'  目标:       {tgt}\n'
            f'  连接状态:   {conn}\n'
            f'  收到消息:   {self.msg_count} 条\n'
            f'  SDK 状态:   {sdk}'
        )
        await _msg_dialog(
            title="Status",
            text=lines,
            style=_HELP_STYLE,
        )

    def _cleanup_target_state(self):
        """切换 target 前清理旧 target 的运行时状态。"""
        self._stop_spinner()
        self._processing.clear()
        self._proc_start.clear()
        self._suppress_next = False
        self._last_sent = None
        self._last_sent_seq = None

    async def set_peer_target(self, name: str) -> bool:
        """校验 AID → 查询 Gateway → 设为 peer 目标并持久化。成功返回 True。"""
        if not _validate_aid(name):
            self._log_write("TARGET", {"action": "set_peer", "aid": name, "error": "invalid_format"})
            return False
        info(f"正在验证 {name} …")
        if not await _aid_exists(name):
            self._log_write("TARGET", {"action": "set_peer", "aid": name, "error": "not_found"})
            error(f"AID 不存在或 Gateway 不可达: {name}")
            return False
        self._log_write("TARGET", {"action": "set_peer", "aid": name, "ok": True})
        self._cleanup_target_state()
        target = {"type": "peer", "id": name, "name": _short_name(name)}
        self.target = target
        _record_target(target)
        cfg = _load_config()
        cfg["target"] = target
        _save_config(cfg)
        info(f"目标: {name}")
        self._pending_menu = None
        asyncio.ensure_future(self.query_menu())
        self._show_unread(name)
        return True

    def set_group_target(self, group_id: str, group_name: str = None) -> bool:
        """设为 group 目标并持久化。"""
        name = group_name or group_id
        self._log_write("TARGET", {"action": "set_group", "group_id": group_id, "name": name})
        self._cleanup_target_state()
        target = {"type": "group", "id": group_id, "name": name}
        self.target = target
        _record_target(target)
        cfg = _load_config()
        cfg["target"] = target
        _save_config(cfg)
        info(f"目标: [{name}]")
        self._pending_menu = None  # 群不支持远端菜单
        self._show_unread(group_id)
        # 后台预加载群成员缓存
        asyncio.ensure_future(self._ensure_members_cache(group_id))
        return True

    def _show_unread(self, conversation_id: str):
        """显示并标记已读某会话的未读消息。"""
        unreads = self.store.get_unread(conversation_id, limit=50)
        if not unreads:
            return
        total = len(unreads)
        _p(f"  {C.DIM}── {total} 条未读消息 ──{C.RESET}")
        for msg in unreads:
            ts_str = datetime.fromtimestamp(msg["timestamp"] / 1000).strftime('%H:%M:%S')
            sender = msg["sender"]
            text = _replace_emoji(msg["payload"])
            rendered = _render_md(text)
            if msg["direction"] == "sent":
                name = _short_name(sender)
                _p(f"{C.DIM}{ts_str}\033[22m {C.YELLOW}▶ {name}\033[39m  {rendered.rstrip()}")
            else:
                name = _short_name(sender)
                lines = rendered.rstrip().split('\n')
                header = f"{C.DIM}{ts_str}\033[22m {C.GREEN}◀ {name}\033[39m"
                if len(lines) > 1:
                    _p(header)
                    for line in lines:
                        _p(line)
                else:
                    _p(f"{header}  {lines[0]}")
        # 如果还有更多未读，提示用户
        counts = self.store.unread_counts()
        remaining = counts.get(conversation_id, 0) - total
        if remaining > 0:
            _p(f"  {C.DIM}还有 {remaining} 条，使用 //history 查看更多{C.RESET}")
        self.store.mark_read(conversation_id)

    def cmd_history(self, arg: str):
        """//history [N] — 查看当前会话历史消息。"""
        if not self.target:
            error("未设置目标"); return
        try:
            limit = int(arg) if arg.strip() else 20
        except ValueError:
            error("用法: //history [条数]"); return
        conversation_id = self.target["id"]
        msgs = self.store.get_history(conversation_id, limit=limit)
        if not msgs:
            info("暂无历史消息"); return
        _p(f"  {C.DIM}── 最近 {len(msgs)} 条消息 ──{C.RESET}")
        for msg in msgs:
            ts_str = datetime.fromtimestamp(msg["timestamp"] / 1000).strftime('%H:%M:%S')
            sender = msg["sender"]
            text = _replace_emoji(msg["payload"])
            rendered = _render_md(text)
            if msg["direction"] == "sent":
                name = _short_name(sender)
                _p(f"{C.DIM}{ts_str}\033[22m {C.YELLOW}▶ {name}\033[39m  {rendered.rstrip()}")
            else:
                name = _short_name(sender)
                lines = rendered.rstrip().split('\n')
                header = f"{C.DIM}{ts_str}\033[22m {C.GREEN}◀ {name}\033[39m"
                if len(lines) > 1:
                    _p(header)
                    for line in lines:
                        _p(line)
                else:
                    _p(f"{header}  {lines[0]}")

    async def resolve_and_switch_target(self, value: str, message: str = "") -> bool:
        """解析 @ 后的值并切换目标。支持 AID、group_id、群名。"""
        if message and not _is_group_target(self.target):
            error("非群聊状态不支持 @target msg，请先切换目标再发送消息")
            return False
        # group_id 格式（必须在 AID 检查之前，因为 g-xxx.agentid.pub 同时满足 _is_valid_aid）
        if _is_group_id(value):
            # 先在本地缓存中查找
            for g in self._group_cache:
                if g.get("group_id") == value:
                    self.set_group_target(value, g.get("name", value))
                    if message:
                        await self.send(message, encrypt=self.encrypt)
                    return True
            # recent_targets 中查
            found = _find_group_in_targets(value)
            if found:
                self.set_group_target(value, found.get("name", value))
                if message:
                    await self.send(message, encrypt=self.encrypt)
                return True
            # 未找到 → 入群引导
            joined = await self._join_group_flow(value)
            if joined and message:
                await self.send(message, encrypt=self.encrypt)
            return True
        # AID 格式
        if _is_valid_aid(value):
            if not await self.set_peer_target(value):
                return False
            if message:
                await self.send(message, encrypt=self.encrypt)
            return True
        # 群名匹配
        for g in self._group_cache:
            if g.get("name") == value:
                self.set_group_target(g["group_id"], value)
                if message:
                    await self.send(message, encrypt=self.encrypt)
                return True
        found = _find_group_in_targets(value)
        if found:
            self.set_group_target(found["id"], found.get("name", value))
            if message:
                await self.send(message, encrypt=self.encrypt)
            return True
        error(f"未找到目标: {value}")
        return False

    async def _join_group_flow(self, group_id: str) -> bool:
        """入群引导流程。成功加入返回 True。"""
        info(f"查询群 {group_id} 的入群要求…")
        requirements_result = None
        requirements_error = None
        try:
            requirements_result = await self.client.call("group.get_join_requirements", {"group_id": group_id})
        except Exception as e:
            requirements_error = e
            if not _is_not_member_error(e):
                error(f"查询失败: {e}")
                return False
            info("当前无法直接读取入群要求，尝试直接申请加入…")

        mode = _join_mode_from_requirements(requirements_result, requirements_error)
        if mode == "closed":
            error("该群组已关闭，不接受新成员")
            return False
        if mode == "invite_only":
            info("加入此群需要邀请码")
            try:
                code = await _async_input("请输入邀请码: ")
            except (EOFError, KeyboardInterrupt):
                info("已取消"); return False
            if not code:
                info("已取消"); return False
            try:
                join_result = await self.client.call("group.use_invite_code", {"code": code.strip()})
                group = join_result.get("group", {})
                self.set_group_target(group_id, group.get("name", group_id))
                info("已加入群组")
                await self._refresh_group_cache()
                return True
            except Exception as e:
                error(f"加入失败: {e}")
            return False
        try:
            confirm = await _async_input(f"是否申请加入群 {group_id}？[y/N] ")
        except (EOFError, KeyboardInterrupt):
            info("已取消"); return False
        if confirm.strip().lower() != 'y':
            info("已取消"); return False
        try:
            join_result = await self.client.call("group.request_join", {"group_id": group_id})
            status = join_result.get("status", "")
            if status == "joined":
                group = join_result.get("group", {})
                self.set_group_target(group_id, group.get("name", group_id))
                info("已加入群组")
                await self._refresh_group_cache()
                return True
            elif status == "question_required":
                question = join_result.get("question", "请回答入群问题")
                info(f"入群问题: {question}")
                try:
                    answer = await _async_input("请输入答案: ")
                except (EOFError, KeyboardInterrupt):
                    info("已取消"); return False
                if not answer:
                    info("已取消"); return False
                join_result2 = await self.client.call("group.request_join", {
                    "group_id": group_id, "answer": answer.strip()
                })
                status2 = join_result2.get("status", "")
                if status2 == "joined":
                    group = join_result2.get("group", {})
                    self.set_group_target(group_id, group.get("name", group_id))
                    info("已加入群组")
                    await self._refresh_group_cache()
                    return True
                elif status2 == "pending":
                    info("入群申请已提交，等待管理员审批")
                else:
                    info(f"入群结果: {status2}")
            elif status == "pending":
                info("入群申请已提交，等待管理员审批")
            else:
                info(f"入群结果: {status}")
        except Exception as e:
            error(f"申请失败: {e}")
        return False

    async def _refresh_group_cache(self):
        """后台刷新群缓存。"""
        if self._group_cache_refreshing:
            return
        if not self.client or not self.connected:
            return
        self._group_cache_refreshing = True
        try:
            result = await self.client.call("group.list_my", {"size": 200})
            self._group_cache = result.get("items", [])
            self._group_cache_at = asyncio.get_event_loop().time()
        except Exception:
            pass
        finally:
            self._group_cache_refreshing = False

    def _get_group_name(self, group_id: str) -> str:
        """从缓存获取群名，未找到则返回 group_id。"""
        for g in self._group_cache:
            if g.get("group_id") == group_id:
                return g.get("name", group_id)
        found = _find_group_in_targets(group_id)
        if found:
            return found.get("name", group_id)
        return group_id

    def is_current_group_owner_cached(self) -> bool | None:
        if not self.target or not _is_group_target(self.target):
            return None
        gid = self.target.get("id")
        for g in self._group_cache:
            if g.get("group_id") == gid:
                role = g.get("role")
                if role:
                    return role == "owner"
        for m in self._members_cache.get(gid, []):
            if m.get("aid") == self.my_aid:
                role = m.get("role")
                if role:
                    return role == "owner"
        return None

    async def is_current_group_owner(self) -> bool | None:
        cached = self.is_current_group_owner_cached()
        if cached is not None:
            return cached
        if not self.target or not _is_group_target(self.target) or not self.client:
            return None
        try:
            result = await self.client.call("group.get", {"group_id": self.target["id"]})
            group = result.get("group", {}) if isinstance(result, dict) else {}
            return group.get("owner_aid") == self.my_aid
        except Exception:
            return None

    async def _ensure_members_cache(self, group_id: str, force=False):
        """确保群成员缓存有效，过期则刷新。force=True 跳过 TTL 检查。"""
        now = asyncio.get_event_loop().time()
        if not force and group_id in self._members_cache and now - self._members_cache_at.get(group_id, 0) < self._members_cache_ttl:
            return
        if not self.client or not self.connected:
            return
        try:
            result = await self.client.call("group.get_members", {"group_id": group_id, "size": 200})
            self._members_cache[group_id] = result.get("members", [])
            self._members_cache_at[group_id] = now
        except Exception:
            pass

    def _get_members(self, group_id: str) -> list:
        """获取群成员缓存（同步，不触发刷新）。"""
        return self._members_cache.get(group_id, [])

    async def send_with_mention(self, text: str, mention_aids: list):
        """发送群消息并 mention 指定成员。"""
        if not self.target or not _is_group_target(self.target):
            error("当前非群聊目标"); return
        group_id = self.target["id"]
        target_label = _target_label(self.target)
        payload = {"text": text, "mentions": mention_aids}
        try:
            t0 = asyncio.get_event_loop().time()
            result = await self.client.call("group.send", {
                "group_id": group_id, "payload": payload,
                "type": "text", "encrypt": self.encrypt,
            })
            elapsed = int((asyncio.get_event_loop().time() - t0) * 1000)
            _record_target(self.target)
            self._log_write("SEND", {
                "to": group_id, "text": text,
                "mentions": mention_aids, "encrypt": self.encrypt,
                "result": _strip_send_result(result),
            })
            if self.debug_mode:
                print_status(target_label, "▶", C.YELLOW, f"已发送 ({elapsed}ms)")
            # 持久化已发消息
            msg_id = (result.get("message_id") if isinstance(result, dict) else None) \
                     or f"sent_{group_id}_{int(time.time()*1000)}"
            self.store.save(
                message_id=msg_id,
                conversation_id=group_id,
                conversation_type="group",
                direction="sent",
                sender=self.my_aid,
                payload=text,
                seq=None,
                timestamp=int(time.time() * 1000),
                is_read=1,
            )
            self.msg_count += 1
            if self._spinner_session:
                self._spinner_session.app.invalidate()
        except Exception as e:
            error(f"发送失败: {e}")

    def _clear_target(self):
        """清除当前目标并持久化。"""
        self.target = None
        cfg = _load_config()
        cfg.pop("target", None)
        _save_config(cfg)

    def _require_group_target(self) -> bool:
        """校验当前 target 是否为 group，否则报错。"""
        if not self.target or not _is_group_target(self.target):
            error("当前目标不是群组，请用 @group_id 切换")
            return False
        return True

    async def _on_group_message(self, data):
        """处理群消息事件。"""
        if not isinstance(data, dict):
            return
        group_id = data.get("group_id", "")
        msg = data.get("message", data)  # SDK 解密后可能直接在 data 层
        sender_aid = msg.get("sender_aid", "?")
        payload = msg.get("payload", {})
        msg_type = msg.get("message_type", msg.get("type", "text"))

        # 忽略自己发的消息
        if sender_aid == self.my_aid:
            return

        # raw log
        ts = datetime.now().strftime('%H:%M:%S')
        entry = f"[{ts}] [group] {json.dumps(data, ensure_ascii=False, default=str)}"
        self._raw_log.append(entry)
        cap = 500 if self._raw_monitor_app else (20 if self.debug_mode else 5)
        if len(self._raw_log) > cap:
            self._raw_log = self._raw_log[-cap:]
        if self._raw_monitor_app is not None:
            self._raw_monitor_app.invalidate()

        # 数据日志
        self._log_write("RECV_GROUP", data)

        # processing / menu 状态通知
        if self._handle_status_payload(payload, sender_aid, conversation_id=group_id):
            return

        # 更新加密状态指示器（群聊 MLS 或明文）
        e2ee = data.get("e2ee") or msg.get("e2ee") or {}
        msg_encrypted = bool(e2ee)
        self.last_e2ee = "🔒 E2EE" if msg_encrypted else "🔓 明文"
        if self.encrypt and not msg_encrypted:
            self.plaintext_recv += 1

        # 提取文本
        if isinstance(payload, dict):
            text = payload.get("text", json.dumps(payload, ensure_ascii=False))
        elif isinstance(payload, str):
            text = payload
        else:
            text = str(payload)

        # 群名
        group_name = self._get_group_name(group_id)
        sender_name = _short_name(sender_aid)

        # 记录到最近目标
        _record_target({"type": "group", "id": group_id, "name": group_name})

        self.msg_count += 1
        is_current = self.target and self.target.get("id") == group_id

        # 提取纯文本（存储和显示都需要）
        text = _replace_emoji(text)

        # 非当前 target → 静默存储，不打印
        if not is_current:
            msg_obj = data.get("message", data)
            msg_id = msg_obj.get("message_id") or f"grp_{group_id}_{sender_aid}_{int(time.time()*1000)}"
            self.store.save(
                message_id=msg_id,
                conversation_id=group_id,
                conversation_type="group",
                direction="recv",
                sender=sender_aid,
                payload=text,
                seq=msg_obj.get("seq"),
                timestamp=int(time.time() * 1000),
                is_read=0,
            )
            # 附件仍需下载
            attachments = payload.get("attachments") if isinstance(payload, dict) else None
            if attachments and isinstance(attachments, list):
                asyncio.ensure_future(self._handle_attachments(attachments, sender_aid))
            return

        # 去重：本地已有的消息跳过显示
        msg_obj = data.get("message", data)
        msg_id = msg_obj.get("message_id")
        if msg_id and self.store.exists(msg_id):
            return

        rendered = _render_md(text)
        lines = rendered.rstrip().split('\n')
        header = f"{C.DIM}{ts}\033[22m {C.GREEN}◀ [{group_name}] {sender_name}\033[39m"
        if len(lines) > 1:
            _p(header)
            for line in lines:
                _p(line)
        else:
            _p(f"{header}  {lines[0]}")

        # 附件自动下载
        attachments = payload.get("attachments") if isinstance(payload, dict) else None
        if attachments and isinstance(attachments, list):
            asyncio.ensure_future(self._handle_attachments(attachments, sender_aid))

        # 持久化消息
        if not msg_id:
            msg_id = f"grp_{group_id}_{sender_aid}_{int(time.time()*1000)}"
        self.store.save(
            message_id=msg_id,
            conversation_id=group_id,
            conversation_type="group",
            direction="recv",
            sender=sender_aid,
            payload=text,
            seq=msg_obj.get("seq"),
            timestamp=int(time.time() * 1000),
            is_read=1,
        )

    async def _on_group_changed(self, data):
        """处理群变更事件。"""
        if not isinstance(data, dict):
            return
        group_id = data.get("group_id", "")
        action = data.get("action", "")
        group_name = self._get_group_name(group_id)

        # raw log
        ts = datetime.now().strftime('%H:%M:%S')
        entry = f"[{ts}] [group.changed] {json.dumps(data, ensure_ascii=False, default=str)}"
        self._raw_log.append(entry)
        cap = 500 if self._raw_monitor_app else (20 if self.debug_mode else 5)
        if len(self._raw_log) > cap:
            self._raw_log = self._raw_log[-cap:]
        if self._raw_monitor_app is not None:
            self._raw_monitor_app.invalidate()

        # 数据日志
        self._log_write("EVENT_GROUP", data)

        # gap-fill 补发的 group.message_created 事件壳（没有 action、没有正文）
        # 不做界面展示，只留在 raw log / 数据日志里
        event_type = data.get("event_type", "")
        if event_type == "group.message_created":
            return
        if not action:
            return

        _ACTION_LABELS = {
            "member_added": "有新成员加入",
            "member_left": "有成员离开",
            "member_removed": "有成员被移除",
            "role_changed": "角色已变更",
            "owner_transferred": "群主已转让",
            "rules_updated": "群规则已更新",
            "announcement_updated": "公告已更新",
            "join_requested": "收到入群申请",
            "joined": "有新成员加入",
            "join_approved": "入群申请已通过",
            "join_rejected": "入群申请已拒绝",
            "invite_code_created": "邀请码已创建",
            "invite_code_used": "邀请码已使用",
            "invite_code_revoked": "邀请码已撤销",
            "member_banned": "有成员被封禁",
            "member_unbanned": "有成员被解封",
            "suspended": "群组已暂停",
            "resumed": "群组已恢复",
            "dissolved": "群组已解散",
            "update": "群信息已更新",
            "upsert": "群信息已更新",
        }
        label = _ACTION_LABELS.get(action, action)
        _p(f"{C.DIM}{ts}\033[22m {C.CYAN}· [{group_name}]\033[39m  {C.DIM}{label}\033[22m")

        # 刷新群缓存（成员变化/群信息变化时）
        if action in ("member_added", "member_left", "member_removed", "joined",
                       "join_approved", "update", "upsert", "dissolved"):
            asyncio.ensure_future(self._refresh_group_cache())

    # ── 群命令处理 ────────────────────────────────────────────────────────

    async def _dispatch_group_cmd(self, cmd_name: str, arg: str):
        """分发群命令。支持 /user + aid、/user ban + aid 等语法。"""
        # 解析 +/- 动作前缀: "/user + aid" 或 "/user +aid"
        action = ""
        if arg:
            stripped = arg.lstrip()
            if stripped and stripped[0] in ('+', '-'):
                action = stripped[0]
                arg = stripped[1:].lstrip()

        # 用查找表映射
        method_map = {
            "list": "_cmd_group_member_list",
            "info": "_cmd_group_info",
            "user": "_cmd_group_user_usage",
            "setup": "_cmd_group_set",
            "group": "_cmd_group_manage",
            "join": "_cmd_group_join",
            "quit": "_cmd_group_quit",
        }
        # +/- 动作子命令映射
        _action_map = {
            "user":    {"+": "_cmd_group_user_add",    "-": "_cmd_group_user_kick"},
        }
        # /user 子命令映射 (ban/unban/list 等文本子命令)
        _user_sub_map = {
            "ban":   "_cmd_group_user_ban",
            "unban": "_cmd_group_user_unban",
        }

        method_name = None
        if action and cmd_name in _action_map:
            method_name = _action_map[cmd_name].get(action)
        elif not action and cmd_name == "user" and arg:
            # 检查是否是 /user ban ... 或 /user list 等子命令
            sub_parts = arg.split(None, 1)
            sub_cmd = sub_parts[0].lower()
            if sub_cmd in _user_sub_map:
                method_name = _user_sub_map[sub_cmd]
                arg = sub_parts[1] if len(sub_parts) > 1 else ""
        if not method_name:
            method_name = method_map.get(cmd_name)
        if not method_name:
            error(f"未知群命令: /{cmd_name}")
            return
        method = getattr(self, method_name, None)
        if not method:
            error(f"命令未实现: /{cmd_name}")
            return
        await method(arg)

    async def _cmd_group_create(self, arg: str):
        parts = arg.split(None, 2) if arg else []
        name = parts[0] if parts else ""
        visibility = parts[1] if len(parts) > 1 else "private"
        join_mode = parts[2] if len(parts) > 2 else "open"
        if not name:
            try:
                name = await _async_input("群名称: ")
            except (EOFError, KeyboardInterrupt):
                info("已取消"); return
            if not name.strip():
                info("已取消"); return
            name = name.strip()
        try:
            result = await self.client.call("group.create", {
                "name": name, "visibility": visibility, "join_mode": join_mode,
            })
            group = result.get("group", {})
            gid = group.get("group_id", "")
            info(f"群组已创建: {name} ({gid})")
            self.set_group_target(gid, name)
            await self._refresh_group_cache()
        except Exception as e:
            error(f"创建失败: {e}")

    async def _cmd_group_list(self, arg: str):
        try:
            result = await self.client.call("group.list_my", {"size": 200})
            items = result.get("items", [])
            if not items:
                info("未加入任何群组"); return
            current_gid = self.target["id"] if self.target and _is_group_target(self.target) else ""
            for g in items:
                gid = g.get("group_id", "")
                gname = g.get("name", gid)
                count = g.get("member_count", "?")
                marker = " ✓" if gid == current_gid else ""
                info(f"  {gname}  ({gid})  {count}人{marker}")
            info(f"共 {len(items)} 个群组")
        except Exception as e:
            error(f"查询失败: {e}")

    async def _cmd_group_search(self, arg: str):
        query = arg.strip() if arg else ""
        try:
            params = {"size": 20}
            if query:
                params["query"] = query
            result = await self.client.call("group.search", params)
            items = result.get("items", [])
            if not items:
                info("未找到公开群组"); return
            for g in items:
                gid = g.get("group_id", "")
                gname = g.get("name", gid)
                count = g.get("member_count", "?")
                info(f"  {gname}  ({gid})  {count}人")
            info(f"共 {len(items)} 个结果")
        except Exception as e:
            error(f"搜索失败: {e}")

    async def _cmd_group_info(self, arg: str):
        if not self._require_group_target(): return
        gid = self.target["id"]
        try:
            result = await self.client.call("group.get", {"group_id": gid})
            g = result.get("group", {})
            info(f"  名称:     {g.get('name', '?')}")
            info(f"  ID:       {g.get('group_id', '?')}")
            info(f"  群主:     {g.get('owner_aid', '?')}")
            info(f"  可见性:   {g.get('visibility', '?')}")
            join_mode = g.get('join_mode', '')
            if not join_mode:
                try:
                    jr = await self.client.call("group.get_join_requirements", {"group_id": gid})
                    join_mode = jr.get("join_requirements", {}).get("mode", "?")
                except Exception:
                    join_mode = "?"
            if join_mode == "invite_only":
                join_mode = "invite"
            info(f"  入群模式: {join_mode}")
            info(f"  状态:     {g.get('status', '?')}")
            info(f"  成员数:   {g.get('member_count', '?')}")
            info(f"  消息序号: {g.get('message_seq', 0)}")
            desc = g.get("description", "")
            if desc:
                info(f"  描述:     {desc}")
            # 群公告
            try:
                ann_result = await self.client.call("group.get_announcement", {"group_id": gid})
                ann = ann_result.get("announcement", {})
                content = ann.get("content", "")
                if content:
                    info(f"  公告:     {content}")
            except Exception:
                pass
        except Exception as e:
            error(f"查询失败: {e}")

    async def _cmd_group_set(self, arg: str):
        """统一设置命令: /set name xxx, /set desc xxx, /set notice xxx, /set mode xxx, /set rules k=v"""
        if not self._require_group_target(): return
        gid = self.target["id"]
        parts = arg.split(None, 1) if arg else []
        sub = parts[0].lower() if parts else ""
        val = parts[1].strip() if len(parts) > 1 else ""

        if sub == "name":
            if not val:
                error("用法: /setup name <新名称>"); return
            try:
                await self.client.call("group.update", {"group_id": gid, "name": val})
                self.target["name"] = val
                _record_target(self.target)
                cfg = _load_config()
                cfg["target"] = self.target
                _save_config(cfg)
                info(f"群名已更新: {val}")
                await self._refresh_group_cache()
            except Exception as e:
                error(f"更新失败: {e}")

        elif sub == "desc":
            if not val:
                error("用法: /setup desc <描述>"); return
            try:
                await self.client.call("group.update", {"group_id": gid, "description": val})
                info("群描述已更新")
            except Exception as e:
                error(f"更新失败: {e}")

        elif sub == "notice":
            if not val:
                error("用法: /setup notice <公告内容>"); return
            try:
                await self.client.call("group.update_announcement", {"group_id": gid, "content": val})
                info("公告已更新")
            except Exception as e:
                error(f"更新失败: {e}")

        elif sub == "mode":
            valid_modes = ("open", "invite", "approval", "closed")
            if not val:
                try:
                    result = await self.client.call("group.get_join_requirements", {"group_id": gid})
                    current = result.get("join_requirements", {}).get("mode", "?")
                    if current == "invite_only":
                        current = "invite"
                    info(f"当前入群模式: {current}")
                    info(f"可选: {', '.join(valid_modes)}")
                except Exception as e:
                    error(f"查询失败: {e}")
                return
            if val not in valid_modes:
                error(f"无效模式: {val}（可选: {', '.join(valid_modes)}）"); return
            api_mode = "invite_only" if val == "invite" else val
            try:
                await self.client.call("group.update_join_requirements", {"group_id": gid, "mode": api_mode})
                info(f"入群模式已更新: {val}")
            except Exception as e:
                error(f"更新失败: {e}")

        elif sub == "role":
            parts2 = val.split() if val else []
            if len(parts2) < 2:
                error("用法: /setup role <aid> <admin|member>"); return
            aid, role = parts2[0], parts2[1]
            try:
                await self.client.call("group.set_role", {"group_id": gid, "aid": aid, "role": role})
                info(f"{_short_name(aid)} 角色已设为 {role}")
            except Exception as e:
                error(f"设置失败: {e}")

        else:
            info("用法: /setup <name|desc|notice|mode|role> [值]")
            info("  /setup name 新群名")
            info("  /setup desc 群描述")
            info("  /setup notice [公告内容]   无参数则查看")
            info("  /setup mode [open|invite|approval|closed]")
            info("  /setup role <aid> <admin|member>")

    async def _cmd_group_manage(self, arg: str):
        """统一群管理命令: /group transfer/suspend/resume/quit/dissolve"""
        if not self._require_group_target(): return
        gid = self.target["id"]
        parts = arg.split(None, 1) if arg else []
        sub = parts[0].lower() if parts else ""
        val = parts[1].strip() if len(parts) > 1 else ""

        if sub == "transfer":
            aid = val
            if not aid:
                error("用法: /group transfer <aid>"); return
            try:
                await self.client.call("group.transfer_owner", {"group_id": gid, "new_owner": aid})
                info(f"群主已转让给 {_short_name(aid)}")
            except Exception as e:
                error(f"转让失败: {e}")

        elif sub == "suspend":
            try:
                await self.client.call("group.suspend", {"group_id": gid})
                info("群组已暂停")
            except Exception as e:
                error(f"暂停失败: {e}")

        elif sub == "resume":
            try:
                await self.client.call("group.resume", {"group_id": gid})
                info("群组已恢复")
            except Exception as e:
                error(f"恢复失败: {e}")

        elif sub == "dissolve":
            gname = self.target.get("name", gid)
            try:
                await self.client.call("group.dissolve", {"group_id": gid})
                info(f"群组 [{gname}] 已解散")
                self._clear_target()
                await self._refresh_group_cache()
            except Exception as e:
                error(f"解散失败: {e}")

        else:
            info("用法: /group(/g) <transfer|suspend|resume|dissolve>")
            info("  /g transfer <aid>  转让群主")
            info("  /g suspend         暂停群组")
            info("  /g resume          恢复群组")
            info("  /g dissolve        解散群组")

    async def _cmd_group_name(self, arg: str):
        if not self._require_group_target(): return
        new_name = arg.strip()
        if not new_name:
            error("用法: /name <新名称>"); return
        try:
            await self.client.call("group.update", {"group_id": self.target["id"], "name": new_name})
            self.target["name"] = new_name
            _record_target(self.target)
            cfg = _load_config()
            cfg["target"] = self.target
            _save_config(cfg)
            info(f"群名已更新: {new_name}")
            await self._refresh_group_cache()
        except Exception as e:
            error(f"更新失败: {e}")

    async def _cmd_group_desc(self, arg: str):
        if not self._require_group_target(): return
        desc = arg.strip()
        if not desc:
            error("用法: /desc <描述>"); return
        try:
            await self.client.call("group.update", {"group_id": self.target["id"], "description": desc})
            info("群描述已更新")
        except Exception as e:
            error(f"更新失败: {e}")

    async def _cmd_group_notice(self, arg: str):
        if not self._require_group_target(): return
        gid = self.target["id"]
        if not arg.strip():
            # 查看公告
            try:
                result = await self.client.call("group.get_announcement", {"group_id": gid})
                ann = result.get("announcement", {})
                content = ann.get("content", "")
                if content:
                    info(f"公告: {content}")
                else:
                    info("暂无公告")
            except Exception as e:
                error(f"查询失败: {e}")
        else:
            # 更新公告
            try:
                await self.client.call("group.update_announcement", {"group_id": gid, "content": arg.strip()})
                info("公告已更新")
            except Exception as e:
                error(f"更新失败: {e}")

    async def _cmd_group_rules(self, arg: str):
        """群规则: /rules 查看, /rules key=value 修改"""
        if not self._require_group_target(): return
        gid = self.target["id"]
        if not arg.strip():
            try:
                result = await self.client.call("group.get_rules", {"group_id": gid})
                rules = result.get("rules", {})
                if not rules:
                    info("暂无群规则"); return
                for k, v in rules.items():
                    info(f"  {k}: {v}")
            except Exception as e:
                error(f"查询失败: {e}")
        else:
            params = {"group_id": gid}
            for kv in arg.strip().split():
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    if v.lower() in ("true", "false"):
                        params[k] = v.lower() == "true"
                    else:
                        try:
                            params[k] = int(v)
                        except ValueError:
                            params[k] = v
            try:
                await self.client.call("group.update_rules", params)
                info("群规则已更新")
            except Exception as e:
                error(f"更新失败: {e}")

    async def _cmd_group_role(self, arg: str):
        if not self._require_group_target(): return
        parts = arg.strip().split()
        if len(parts) < 2:
            error("用法: /role <aid> <admin|member>"); return
        aid, role = parts[0], parts[1]
        try:
            await self.client.call("group.set_role", {"group_id": self.target["id"], "aid": aid, "role": role})
            info(f"{_short_name(aid)} 角色已设为 {role}")
        except Exception as e:
            error(f"设置失败: {e}")

    async def _cmd_group_transfer(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /transfer <aid>"); return
        try:
            await self.client.call("group.transfer_owner", {"group_id": self.target["id"], "new_owner": aid})
            info(f"群主已转让给 {_short_name(aid)}")
        except Exception as e:
            error(f"转让失败: {e}")

    async def _cmd_group_quit(self, arg: str):
        if not self._require_group_target(): return
        gid = self.target["id"]
        gname = self.target.get("name", gid)
        try:
            result = await self.client.call("group.get", {"group_id": gid})
            group = result.get("group", {})
            is_owner = group.get("owner_aid") == self.my_aid
        except Exception:
            is_owner = False
        if is_owner:
            info("你是群主，请选择操作:")
            info("  1. 解散群组")
            info("  2. 转让群主后退出")
            info("  3. 取消操作")
            try:
                choice = await _async_input("请选择 [1/2/3]: ")
            except (EOFError, KeyboardInterrupt):
                info("已取消"); return
            if choice.strip() == "1":
                try:
                    confirm = await _async_input(f"确认解散群组 [{gname}]？输入 y 确认: ")
                except (EOFError, KeyboardInterrupt):
                    info("已取消"); return
                if confirm.strip().lower() != 'y':
                    info("已取消"); return
                try:
                    await self.client.call("group.dissolve", {"group_id": gid})
                    info(f"群组 [{gname}] 已解散")
                    self._clear_target()
                    await self._refresh_group_cache()
                except Exception as e:
                    error(f"解散失败: {e}")
            elif choice.strip() == "2":
                try:
                    new_aid = await _async_input("转让给 (AID): ")
                except (EOFError, KeyboardInterrupt):
                    info("已取消"); return
                if not new_aid.strip():
                    info("已取消"); return
                try:
                    await self.client.call("group.transfer_owner", {"group_id": gid, "new_owner": new_aid.strip()})
                    await self.client.call("group.leave", {"group_id": gid})
                    info(f"已退出群组 [{gname}]")
                    self._clear_target()
                    await self._refresh_group_cache()
                except Exception as e:
                    error(f"操作失败: {e}")
            else:
                info("已取消")
        else:
            try:
                confirm = await _async_input(f"确认退出群组 [{gname}]？输入 y 确认: ")
            except (EOFError, KeyboardInterrupt):
                info("已取消"); return
            if confirm.strip().lower() != 'y':
                info("已取消"); return
            try:
                await self.client.call("group.leave", {"group_id": gid})
                info(f"已退出群组 [{gname}]")
                self._clear_target()
                await self._refresh_group_cache()
            except Exception as e:
                error(f"退出失败: {e}")

    async def _cmd_group_suspend(self, arg: str):
        if not self._require_group_target(): return
        try:
            await self.client.call("group.suspend", {"group_id": self.target["id"]})
            info("群组已暂停")
        except Exception as e:
            error(f"暂停失败: {e}")

    async def _cmd_group_resume(self, arg: str):
        if not self._require_group_target(): return
        try:
            await self.client.call("group.resume", {"group_id": self.target["id"]})
            info("群组已恢复")
        except Exception as e:
            error(f"恢复失败: {e}")

    async def _cmd_group_member_list(self, arg: str):
        """/list — 成员列表"""
        await self._cmd_group_user(arg)

    async def _cmd_group_user_usage(self, arg: str):
        """/user 无参数 — 显示用法"""
        info("用法:")
        info("  /u + <aid>       添加成员")
        info("  /u - <aid>       踢出成员")
        info("  /u ban [aid]     封禁列表/封禁成员")
        info("  /u unban <aid>   解封成员")
        info("  /list            查看成员列表")

    async def _cmd_group_user(self, arg: str):
        if not self._require_group_target(): return
        try:
            result = await self.client.call("group.get_members", {"group_id": self.target["id"], "size": 200})
            members = result.get("members", [])
            # 回写 cache，保持 /user 和 @ 补全一致
            group_id = self.target["id"]
            self._members_cache[group_id] = members
            self._members_cache_at[group_id] = asyncio.get_event_loop().time()
            if not members:
                info("暂无成员"); return
            for m in members:
                aid = m.get("aid", "?")
                role = m.get("role", "member")
                role_icon = {"owner": "👑", "admin": "⭐"}.get(role, "  ")
                info(f"  {role_icon} {_short_name(aid)}  ({aid})  {role}")
            info(f"共 {len(members)} 名成员")
        except Exception as e:
            error(f"查询失败: {e}")

    async def _cmd_group_user_add(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /u + <aid>"); return
        try:
            await self.client.call("group.add_member", {"group_id": self.target["id"], "aid": aid})
            info(f"已添加成员 {_short_name(aid)}")
        except Exception as e:
            error(f"添加失败: {e}")

    async def _cmd_group_user_kick(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /u - <aid>"); return
        try:
            await self.client.call("group.kick", {"group_id": self.target["id"], "aid": aid})
            info(f"已移除成员 {_short_name(aid)}")
        except Exception as e:
            error(f"移除失败: {e}")

    async def _cmd_group_user_ban(self, arg: str):
        """封禁成员: /user ban <aid>，无参数则列出封禁名单。"""
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            # 列出封禁名单
            try:
                result = await self.client.call("group.get_banlist", {"group_id": self.target["id"]})
                items = result.get("items", [])
                if not items:
                    info("暂无封禁成员"); return
                for b in items:
                    a = b.get("aid", "?")
                    info(f"  {_short_name(a)}  ({a})")
            except Exception as e:
                error(f"查询失败: {e}")
            return
        try:
            await self.client.call("group.ban", {"group_id": self.target["id"], "aid": aid})
            info(f"已封禁 {_short_name(aid)}")
        except Exception as e:
            error(f"封禁失败: {e}")

    async def _cmd_group_user_unban(self, arg: str):
        """解封成员: /user unban <aid>"""
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /user unban <aid>"); return
        try:
            await self.client.call("group.unban", {"group_id": self.target["id"], "aid": aid})
            info(f"已解封 {_short_name(aid)}")
        except Exception as e:
            error(f"解封失败: {e}")

    async def _cmd_group_join(self, arg: str):
        """/join — 入群管理: /join inv [+/-], /join req [+/-]"""
        if not self._require_group_target(): return
        parts = arg.split(None, 1) if arg else []
        sub = parts[0].lower() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""

        # 解析 rest 中的 +/- 动作
        action = ""
        if rest and rest[0] in ('+', '-'):
            action = rest[0]
            rest = rest[1:].lstrip()

        if sub in ("inv", "invite"):
            if action == "+":
                await self._cmd_group_invite_create(rest)
            elif action == "-":
                await self._cmd_group_invite_revoke(rest)
            else:
                await self._cmd_group_invite_list(rest)
        elif sub in ("req", "request"):
            if action == "+":
                await self._cmd_group_request_approve(rest)
            elif action == "-":
                await self._cmd_group_request_reject(rest)
            else:
                await self._cmd_group_request_list(rest)
        else:
            info("用法: /join <inv|req> [+/-] [参数]")
            info("  /join inv          邀请码列表")
            info("  /join inv +        创建邀请码")
            info("  /join inv - <code> 撤销邀请码")
            info("  /join req          入群申请列表")
            info("  /join req + <aid>  批准申请")
            info("  /join req - <aid>  拒绝申请")

    async def _cmd_group_invite_list(self, arg: str):
        if not self._require_group_target(): return
        try:
            result = await self.client.call("group.list_invite_codes", {"group_id": self.target["id"]})
            items = result.get("items", [])
            if not items:
                info("暂无邀请码"); return
            for inv in items:
                code = inv.get("code", "?")
                uses = inv.get("use_count", 0)
                max_uses = inv.get("max_uses", 1)
                status = inv.get("status", "?")
                info(f"  {code}  {uses}/{max_uses}  {status}")
        except Exception as e:
            error(f"查询失败: {e}")

    async def _cmd_group_invite_create(self, arg: str):
        if not self._require_group_target(): return
        params = {"group_id": self.target["id"]}
        if arg.strip():
            # 可选参数: max_uses
            try:
                params["max_uses"] = int(arg.strip())
            except ValueError:
                params["code"] = arg.strip()
        try:
            result = await self.client.call("group.create_invite_code", params)
            inv = result.get("invite_code", {})
            info(f"邀请码: {inv.get('code', '?')}")
        except Exception as e:
            error(f"创建失败: {e}")

    async def _cmd_group_invite_revoke(self, arg: str):
        if not self._require_group_target(): return
        code = arg.strip()
        if not code:
            error("用法: /inv - <code>"); return
        try:
            await self.client.call("group.revoke_invite_code", {"group_id": self.target["id"], "code": code})
            info(f"邀请码已撤销: {code}")
        except Exception as e:
            error(f"撤销失败: {e}")

    async def _cmd_group_request_list(self, arg: str):
        if not self._require_group_target(): return
        try:
            result = await self.client.call("group.list_join_requests", {"group_id": self.target["id"]})
            items = result.get("items", [])
            if not items:
                info("暂无入群申请"); return
            for req in items:
                aid = req.get("aid", "?")
                status = req.get("status", "?")
                msg = req.get("message", "")
                line = f"  {_short_name(aid)}  ({aid})  {status}"
                if msg:
                    line += f"  \"{msg}\""
                info(line)
        except Exception as e:
            error(f"查询失败: {e}")

    async def _cmd_group_request_approve(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /req + <aid>"); return
        try:
            await self.client.call("group.review_join_request", {
                "group_id": self.target["id"], "aid": aid, "approve": True,
            })
            info(f"已批准 {_short_name(aid)} 的入群申请")
        except Exception as e:
            error(f"操作失败: {e}")

    async def _cmd_group_request_reject(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /req - <aid>"); return
        try:
            await self.client.call("group.review_join_request", {
                "group_id": self.target["id"], "aid": aid, "approve": False,
            })
            info(f"已拒绝 {_short_name(aid)} 的入群申请")
        except Exception as e:
            error(f"操作失败: {e}")

    async def close(self):
        if self._log_enabled and self._log_file:
            self._log_write("SYSTEM", "=== 日志结束 ===")
            try:
                self._log_file.close()
            except Exception:
                pass
            self._log_file = None
            self._log_date = None
            # 注意：不改 _log_enabled 和 config，下次启动自动恢复
        if self.client:
            try:
                await self.client.close()
            except Exception:
                pass
        self.connected = False

    # ── SDK 事件处理 ──────────────────────────────────────────────────────

    async def _on_ack(self, data):
        # ack 只写入日志，不在界面显示
        # 发送成功的提示由 send() 路径自行打印（debug 模式下显示耗时，非 debug 模式不展示）
        if isinstance(data, dict):
            self._log_write("EVENT", {"type": "message.ack", **data})

    async def _on_token_refreshed(self, data):
        self._log_write("EVENT", {"type": "token.refreshed", "data": data})
        self._last_e2ee_event = {"type": "token.refreshed", "data": data, "time": datetime.now()}
        self.last_e2ee = "🔑 Token已刷新"
        # 3秒后恢复
        if self._e2ee_restore_timer is not None:
            self._e2ee_restore_timer.cancel()
        loop = asyncio.get_event_loop()
        self._e2ee_restore_timer = loop.call_later(3, self._restore_e2ee)

    def _restore_e2ee(self):
        self.last_e2ee = "🔒 E2EE"
        self._e2ee_restore_timer = None

    async def _on_e2ee_degraded(self, data):
        self._log_write("EVENT", {"type": "e2ee.degraded", "data": data})
        self._last_e2ee_event = {"type": "e2ee.degraded", "data": data if isinstance(data, dict) else {}, "time": datetime.now()}
        self.last_e2ee = "⚠️ E2EE降级"

    async def _on_e2ee_error(self, data):
        self._log_write("EVENT", {"type": "e2ee.orchestration_error", "data": data})
        self._last_e2ee_event = {"type": "e2ee.orchestration_error", "data": data if isinstance(data, dict) else {}, "time": datetime.now()}
        self.last_e2ee = "❌ E2EE错误"

    # ── 调试命令 ──────────────────────────────────────────────────────────

    def cmd_debug(self):
        self.debug_mode = not self.debug_mode
        cfg = _load_config()
        cfg["debug"] = self.debug_mode
        _save_config(cfg)
        state = "已开启" if self.debug_mode else "已关闭"
        info(f"debug 模式{state}")

    def _open_log_file(self):
        """打开（或轮转到）当天的日志文件。"""
        date_str = datetime.now().strftime('%Y%m%d')
        if self._log_file and self._log_date == date_str:
            return True  # 已是当天文件
        # 关闭旧文件
        if self._log_file:
            try:
                self._log_file.close()
            except Exception:
                pass
        log_dir = DATA_DIR / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"aun-{date_str}.log"
        try:
            self._log_file = open(log_path, "a", encoding="utf-8")
            self._log_date = date_str
            return True
        except Exception as e:
            self._log_file = None
            self._log_date = None
            error(f"日志文件打开失败: {e}")
            return False

    def _log_write(self, direction: str, data):
        """写入一条日志。direction: 'SEND'/'RECV'/'EVENT' 等标签。"""
        if not self._log_enabled:
            return
        # 跨天自动轮转
        date_str = datetime.now().strftime('%Y%m%d')
        if self._log_date != date_str:
            if not self._open_log_file():
                return
        if not self._log_file:
            return
        ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
        try:
            line = json.dumps(data, ensure_ascii=False, default=str) if not isinstance(data, str) else data
            self._log_file.write(f"[{ts}] [{direction}] {line}\n")
            self._log_file.flush()
        except Exception:
            pass

    def cmd_log(self):
        """toggle 数据日志开关。"""
        if self._log_enabled:
            # 关闭
            self._log_write("SYSTEM", "=== 日志关闭 ===")
            self._log_enabled = False
            if self._log_file:
                try:
                    self._log_file.close()
                except Exception:
                    pass
                self._log_file = None
                self._log_date = None
            cfg = _load_config()
            cfg["log"] = False
            _save_config(cfg)
            info("数据日志已关闭")
        else:
            # 开启
            self._log_enabled = True
            if self._open_log_file():
                self._log_write("SYSTEM", f"=== 日志开始 AID={self.my_aid} ===")
                cfg = _load_config()
                cfg["log"] = True
                _save_config(cfg)
                info(f"数据日志已开启: {self._log_file.name}")
            else:
                self._log_enabled = False

    async def cmd_processing(self):
        if not self._processing:
            await _msg_dialog(
                title="Processing",
                text="  无活跃处理",
                style=_HELP_STYLE,
            )
            return
        lines = []
        for i, sid in enumerate(self._processing, 1):
            short_sid = sid if len(sid) <= 20 else sid[:17] + "..."
            start_t = self._proc_start.get(sid)
            if start_t is not None:
                secs = int(asyncio.get_event_loop().time() - start_t)
                lines.append(f"  #{i}  {short_sid}  处理中，已耗时{secs}秒")
            else:
                lines.append(f"  #{i}  {short_sid}  处理中")
        await _msg_dialog(
            title="Processing",
            text="\n".join(lines),
            style=_HELP_STYLE,
        )

    async def cmd_rawdata(self):
        """实时原始数据监控台（全屏 TUI）。"""
        sep = "─" * 60

        init_text = ("  等待数据…\n\n  收到的 Gateway 原始消息将实时显示在这里。\n"
                     "  已缓存的历史数据也会显示。")
        buf = Buffer(document=Document(init_text, len(init_text)), read_only=True)
        body = Window(
            content=BufferControl(buffer=buf, focusable=False,
                                  search_buffer_control=None),
            wrap_lines=True,
            style="class:body",
        )
        _rendered_count = [0]

        def refresh_body(app):
            count = len(self._raw_log)
            if count == _rendered_count[0]:
                return
            _rendered_count[0] = count
            text = f"\n{sep}\n".join(self._raw_log) if self._raw_log else ""
            buf.set_document(Document(text, len(text)), bypass_readonly=True)

        kb = KeyBindings()

        @kb.add("c-c")
        @kb.add("escape")
        def _(event):
            event.app.exit()

        def get_status():
            conn = "🟢" if self.connected else "🔴"
            mode = "DEBUG" if self.debug_mode else "NORMAL"
            return f" {conn} Raw Monitor [{mode}]  |  {len(self._raw_log)} 条  |  Ctrl+C / Esc 退出"

        monitor_style = Style.from_dict({
            "title-bar":  "bg:#2a3a4a #ffff00 bold",
            "body":       "bg:default #aaaaaa",
            "status-bar": "bg:#2a3a4a #aaaaaa",
        })

        root = HSplit([
            Window(
                content=FormattedTextControl(" Raw Data Monitor"),
                height=1,
                style="class:title-bar",
            ),
            body,
            Window(
                content=FormattedTextControl(get_status),
                height=1,
                style="class:status-bar",
            ),
        ])

        app = Application(
            layout=Layout(root),
            full_screen=True,
            key_bindings=kb,
            style=monitor_style,
            mouse_support=False,
            refresh_interval=1,
        )
        app.after_render += refresh_body

        self._raw_monitor_app = app
        try:
            await app.run_async()
        finally:
            self._raw_monitor_app = None

    def cmd_e2ee(self):
        info("── E2EE ──")
        # 当前收发模式
        mode = "🔒 E2EE" if self.encrypt else "🔓 明文"
        info(f"收发模式: {mode}")
        # 最近收到消息的加密状态
        if self.last_e2ee:
            info(f"最近收到: {self.last_e2ee}")
        else:
            info(f"最近收到: (无消息)")
        if self.plaintext_recv:
            info(f"E2EE 模式下收到明文: {self.plaintext_recv}")
        # 最近事件
        ev = self._last_e2ee_event
        if ev is None:
            info("最近事件: 无")
            return
        info(f"最近事件: {ev['type']}")
        data = ev.get("data", {})
        if isinstance(data, dict):
            if data.get("peer"):
                info(f"  peer:   {data['peer']}")
            if data.get("reason"):
                info(f"  reason: {data['reason']}")
        t = ev.get("time")
        if t:
            info(f"  时间:   {t.strftime('%H:%M:%S')}")

# ── REPL ──────────────────────────────────────────────────────────────────

_HELP_STYLE = Style.from_dict({
    "dialog":              "bg:default",
    "dialog frame.label":  "bg:#2a3a4a #ffff00 bold",
    "dialog.body":         "bg:default #aaaaaa",
    "dialog shadow":       "bg:#060d1a",
    "button":              "bg:#2a3a4a #ffff00",
    "button.focused":      "bg:#2a3a4a #ffffff bold",
})

async def _msg_dialog(title="", text="", ok_text="Ok", style=None):
    """message_dialog wrapper：禁用鼠标捕获，允许终端原生选择复制。"""
    from prompt_toolkit.widgets import Dialog, Label, Button
    from prompt_toolkit.key_binding.defaults import load_key_bindings
    from prompt_toolkit.key_binding import merge_key_bindings, KeyBindings as KB
    from prompt_toolkit.key_binding.bindings.focus import focus_next, focus_previous

    def _return_none():
        app.exit()

    dialog = Dialog(
        title=title,
        body=Label(text=text, dont_extend_height=True),
        buttons=[Button(text=ok_text, handler=_return_none)],
        with_background=True,
    )

    kb = KB()
    kb.add("tab")(focus_next)
    kb.add("s-tab")(focus_previous)
    kb.add("escape", eager=True)(lambda event: app.exit())

    app = Application(
        layout=Layout(dialog),
        key_bindings=merge_key_bindings([load_key_bindings(), kb]),
        mouse_support=False,
        style=style,
        full_screen=True,
    )
    await app.run_async()

def _build_help_text(is_group_owner: bool | None = None) -> str:
    group_lines = [
        '  <ansiyellow>/list</ansiyellow>             成员列表',
        '  <ansiyellow>/info</ansiyellow>             群信息（含公告）',
    ]
    if is_group_owner is not False:
        group_lines.extend([
            '  <ansiyellow>/u + aid</ansiyellow>          添加成员',
            '  <ansiyellow>/u - aid</ansiyellow>          踢出成员',
            '  <ansiyellow>/u ban [aid]</ansiyellow>      封禁列表/封禁',
            '  <ansiyellow>/u unban aid</ansiyellow>      解封成员',
            '  <ansiyellow>/join inv [+/-]</ansiyellow>   邀请码管理',
            '  <ansiyellow>/join req [+/-]</ansiyellow>   入群申请管理',
            '  <ansiyellow>/setup name|desc|notice|mode|role</ansiyellow>  群设置',
            '  <ansiyellow>/g transfer|suspend|resume</ansiyellow>  群管理',
        ])
    group_lines.append('  <ansiyellow>/quit</ansiyellow>             退出群组')
    return (
        '<b>快捷键</b>\n'
        '  <ansiyellow>/</ansiyellow>              命令菜单（peer→远端 群→群管理）\n'
        '  <ansiyellow>//</ansiyellow>             本地命令菜单\n'
        '  <ansiyellow>@</ansiyellow>              切换目标 / 群聊 mention\n'
        '  <ansiyellow>Ctrl+J</ansiyellow>         换行（多行输入）\n'
        '  <ansiyellow>Ctrl+L</ansiyellow>         清屏\n'
        '  <ansiyellow>Ctrl+R</ansiyellow>         原始数据监控\n'
        '  <ansiyellow>Ctrl+D</ansiyellow>         toggle 调试模式\n'
        '  <ansiyellow>Ctrl+G</ansiyellow>         toggle 数据日志\n'
        '  <ansiyellow>Esc</ansiyellow>            关闭菜单\n'
        '  <ansiyellow>Ctrl+C</ansiyellow>         中断任务 / 清空输入 / 双击退出\n\n'
        '<b>目标切换 (@)</b>\n'
        '  <ansiyellow>@aid</ansiyellow>           切换到 peer\n'
        '  <ansiyellow>@grp_xxx</ansiyellow>       切换到群组\n'
        '  <ansiyellow>@群名</ansiyellow>          按名称切换群组\n'
        '  <ansiyellow>@aid msg</ansiyellow>       群聊中 mention 成员并发消息\n'
        '  <ansiyellow>@切换目标</ansiyellow>      群聊中切换到其他会话\n\n'
        '<b>本地身份 (//local / //aid)</b>\n'
        '  <ansiyellow>//local &lt;name&gt;</ansiyellow>      切换本地 AID（类似 aun -l）\n'
        '  <ansiyellow>//aid list</ansiyellow>           列出本地所有 AID\n'
        '  <ansiyellow>//aid new &lt;aid&gt;</ansiyellow>     创建新 AID\n'
        '  <ansiyellow>//aid delete &lt;aid&gt;</ansiyellow>  删除本地 AID\n\n'
        '<b>群组 (//qid)</b>\n'
        '  <ansiyellow>//qid add &lt;group_id&gt;</ansiyellow>    加入群组\n'
        '  <ansiyellow>//qid quit &lt;group_id&gt;</ansiyellow>   退出群组\n'
        '  <ansiyellow>//qid search &lt;关键词&gt;</ansiyellow>  搜索公开群组\n\n'
        '<b>群命令（目标为群时 / 触发）</b>\n'
        + '\n'.join(group_lines)
        + '\n\n<b>文件收发</b>\n'
        '  <ansiyellow>//sendfile path</ansiyellow>  发送文件到当前目标'
    )


async def _show_help(cli_ref=None):
    is_group_owner = None
    if cli_ref:
        is_group_owner = await cli_ref.is_current_group_owner()
    await _msg_dialog(
        title=HTML('<style bg="#2a3a4a" fg="#ffff00"> AUN CLI </style>'),
        text=HTML(_build_help_text(is_group_owner)),
        style=_HELP_STYLE,
    )

async def repl(c: AUNCli):
    await _show_help(c)
    _p(f"  {C.DIM}直接输入文本发送消息{C.RESET}")
    def toolbar():
        if _ctrlc_state['hint']:
            return HTML(f" <b>{_ctrlc_state['hint']}</b>")
        conn = "🟢 已连接" if c.connected else "🔴 未连接"
        tgt  = _target_label(c.target) if c.target else "未设置"
        me   = c.my_aid
        enc  = "🔒 E2EE" if c.encrypt else "🔓 明文"
        rej  = f"明文⚠ {c.plaintext_recv}  " if c.plaintext_recv else ""
        dbg  = "  [DEBUG]" if c.debug_mode else ""
        log  = "  [LOG]" if c._log_enabled else ""
        # 未读计数
        unread_str = ""
        try:
            current_id = c.target.get("id") if c.target else None
            counts = c.store.unread_counts()
            parts = []
            for cid, cnt in counts.items():
                if cid == current_id:
                    continue
                label = _short_name(cid) if "." in cid else cid
                parts.append(f"{label}:{cnt}")
            if parts:
                unread_str = "  [" + " | ".join(parts) + "]"
        except Exception:
            pass
        return HTML(f" <b>{conn}</b>  {me}  →  {tgt}  消息: {c.msg_count}  {rej}{enc}{dbg}{log}{unread_str}")

    session = PromptSession(
        completer=AUNCompleter(cli_ref=c),
        validator=AUNValidator(),
        validate_while_typing=True,
        style=STYLE,
        bottom_toolbar=toolbar,
        history=_load_history(),
        complete_while_typing=True,
        key_bindings=_kb,
        multiline=True,
    )
    session.app.ttimeoutlen = 0.05  # 50ms escape 超时
    _ctrlc_state['session'] = session
    _ctrlc_state['_cli'] = c

    # 防抖：替换 prompt_toolkit 内置的即时 resize 重绘
    # 窗口拖拽期间不重绘，松手 300ms 后才执行一次
    if hasattr(signal, 'SIGWINCH'):
        _orig_on_resize = session.app._on_resize
        _resize_handle = [None]
        def _debounced_resize():
            if _resize_handle[0] is not None:
                _resize_handle[0].cancel()
            loop = asyncio.get_event_loop()
            _resize_handle[0] = loop.call_later(0.3, _orig_on_resize)
        session.app._on_resize = _debounced_resize

    c._spinner_session = session

    def prompt_msg():
        parts = []
        if c._spinner_aid:
            frame = c._SPINNER_FRAMES[c._spinner_frame]
            parts.append(("class:spinner", f"  {frame} {c._spinner_aid} 处理中… {c._spinner_elapsed}s\n"))
        parts.append(("class:prompt", " ❯ "))
        return parts

    with patch_stdout():
        while True:
            try:
                line = await session.prompt_async(
                    prompt_msg,
                    style=STYLE,
                )
            except (EOFError, KeyboardInterrupt):
                break

            line = line.strip()
            if not line:
                continue

            if line == "//remote menu":
                # 手动触发远端菜单查询（重置冷却，强制重试）
                c._menu_failures = 0
                c._menu_cooldown_until = 0
                await c.query_menu(manual=True)
                continue

            if line.startswith("//"):
                # // 前缀：本地命令
                local_line = line[2:]  # 去掉 // 得到裸命令
                parts = local_line.split(None, 1)
                cmd, arg = parts[0].lower() if parts else "", (parts[1] if len(parts) > 1 else "")
                if cmd in ("quit", "exit", "q"):
                    break
                elif cmd == "target":
                    if arg:
                        await c.resolve_and_switch_target(arg)
                    else:
                        error("用法: //target <aid|group_id>")
                elif cmd == "ping":
                    await c.ping()
                elif cmd == "status":
                    await c.status()
                elif cmd == "plain":
                    c.encrypt = not c.encrypt
                    c.plaintext_recv = 0
                    cfg = _load_config()
                    cfg["encrypt"] = c.encrypt
                    _save_config(cfg)
                    mode = "🔒 E2EE" if c.encrypt else "🔓 明文"
                    info(f"收发模式: {mode}")
                elif cmd == "debug":
                    c.cmd_debug()
                elif cmd == "log":
                    c.cmd_log()
                elif cmd == "history":
                    c.cmd_history(arg)
                elif cmd == "processing":
                    await c.cmd_processing()
                elif cmd == "rawdata":
                    await c.cmd_rawdata()
                elif cmd == "e2ee":
                    c.cmd_e2ee()
                elif cmd == "sendfile":
                    if arg:
                        await c.send_file(arg)
                    else:
                        error("用法: //sendfile <文件路径>")
                elif cmd == "help":
                    await _show_help(c)
                elif cmd == "local":
                    await _dispatch_local_local_command(c, arg)
                elif cmd == "aid":
                    await _dispatch_local_aid_command(c, arg)
                elif cmd == "qid":
                    await _dispatch_local_qid_command(c, arg)
                else:
                    error(f"未知命令: //{cmd}")
                continue

            if line.startswith("/") and not line.startswith("//"):
                rest = line[1:]
                parts = rest.split(None, 1)
                cmd_input = parts[0] if parts else ""
                arg = parts[1] if len(parts) > 1 else ""

                # 检查是否是不需要群 target 的全局群命令（create/list/search）
                lookup = _GROUP_CMD_LOOKUP.get(cmd_input) if cmd_input else None
                is_global_group_cmd = lookup and not lookup[1]  # need_group=False

                if c.target and _is_group_target(c.target):
                    # 群 target：已知群命令走 dispatch，未知命令透传到远端
                    if cmd_input:
                        if lookup:
                            cmd_name, need_group = lookup
                            if need_group and not c._require_group_target():
                                continue
                            await c._dispatch_group_cmd(cmd_name, arg)
                            continue
                elif is_global_group_cmd:
                    # 非群 target 但是全局群命令（/create, /list, /search）
                    cmd_name, _ = lookup
                    await c._dispatch_group_cmd(cmd_name, arg)
                    continue
                # 透传到远端（fall through）

            if _should_handle_join_as_target_switch(line):
                target, message = _split_target_switch_input(line)
                if target:
                    await c.resolve_and_switch_target(target, message)
                    continue

            # 统一发送：群聊自动提取 @aid 作为 mentions
            if c.target and _is_group_target(c.target):
                mentions = _extract_mentions(line)
                if mentions:
                    await c.send_with_mention(line, mentions)
                else:
                    await c.send(line, encrypt=c.encrypt)
            else:
                await c.send(line, encrypt=c.encrypt)

def _load_history():
    from prompt_toolkit.history import FileHistory, InMemoryHistory
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        return FileHistory(str(HISTORY_FILE))
    except Exception:
        return InMemoryHistory()

async def _dispatch_local_local_command(c, arg: str):
    name = arg.strip()
    if not name:
        error("用法: //local <name>")
        return
    await c.switch_aid(name)


async def _dispatch_local_aid_command(c, arg: str):
    parts2 = arg.split(None, 1)
    action = parts2[0].lower() if parts2 else ""
    arg2 = parts2[1] if len(parts2) > 1 else ""
    if action == "list":
        cmd_aid_list()
    elif action == "new":
        if arg2:
            if _validate_aid(arg2):
                try:
                    await cmd_aid_create(arg2)
                except Exception as e:
                    error(f"创建失败: {e}")
        else:
            error("用法: //aid new <aid>")
    elif action == "delete":
        if arg2:
            if _validate_aid(arg2):
                cmd_aid_delete(arg2)
        else:
            error("用法: //aid delete <aid>")
    elif action:
        error("切换本地 AID 请使用: //local <name>")
    else:
        error("用法: //aid list | new <aid> | delete <aid>")


async def _dispatch_local_qid_command(c, arg: str):
    parts2 = arg.split(None, 1)
    action = parts2[0].lower() if parts2 else ""
    arg2 = parts2[1] if len(parts2) > 1 else ""
    if action == "add":
        await cmd_qid_add(c, arg2)
    elif action == "quit":
        await cmd_qid_quit(c, arg2)
    elif action == "search":
        await cmd_qid_search(c, arg2)
    else:
        error("用法: //qid add <group_id> | quit <group_id> | search <关键词>")


# ── 入口 ──────────────────────────────────────────────────────────────────

def cmd_aid_list():
    ks = _get_keystore()
    aids_root = ks._aids_root
    if not aids_root.exists() or not any(aids_root.iterdir()):
        info("暂无本地 AID"); return
    default = _load_config().get("aid", "")
    for aid in sorted(p.name for p in aids_root.iterdir() if p.is_dir()):
        marker = " ✓" if aid == default else ""
        info(f"{aid}{marker}")

async def cmd_aid_create(name: str):
    client = _make_client()
    client._gateway_url = GATEWAY_URL
    local = _get_keystore().load_identity(name)
    if local and "private_key_pem" in local:
        if local.get("cert"):
            error(f"AID {name} 已存在"); return
        info(f"检测到未完成的创建（本地已有密钥但未在服务端注册），继续尝试注册…")
    try:
        result = await client.auth.create_aid({"aid": name})
    except Exception as e:
        error(f"AID 创建失败: {e}")
        info(f"本地密钥已保留，修复网络后重新执行 `aid new {name}` 可继续注册")
        return
    info(f"AID 创建成功: {result['aid']}")
    cfg = _load_config()
    if not cfg.get("aid"):
        cfg["aid"] = name
        _save_config(cfg)
        info("已设为默认 AID")

def cmd_aid_delete(name: str):
    import shutil
    ks = _get_keystore()
    local = ks.load_identity(name)
    if local is None:
        error(f"AID {name} 不存在"); return
    confirm = input(f"删除 {name}？[y/N] ").strip().lower()
    if confirm != 'y':
        info("已取消"); return

    safe = ks._safe_aid(name)
    removed: list[str] = []
    identity_dir = ks._aids_root / safe
    if identity_dir.exists():
        shutil.rmtree(identity_dir, ignore_errors=True)
        removed.append(str(identity_dir))
    for legacy_root in ks._legacy_roots:
        if not legacy_root.exists():
            continue
        for suffix in (".json", ".key.json", ".cert.pem"):
            p = legacy_root / f"{safe}{suffix}"
            if p.exists():
                try:
                    p.unlink()
                    removed.append(str(p))
                except OSError as e:
                    error(f"删除 {p} 失败: {e}")
        legacy_subdir = legacy_root / safe
        if legacy_subdir.is_dir():
            shutil.rmtree(legacy_subdir, ignore_errors=True)
            removed.append(str(legacy_subdir))

    cfg = _load_config()
    if cfg.get("aid") == name:
        del cfg["aid"]
        _save_config(cfg)
    if removed:
        info(f"已删除 {name}")
    else:
        error(f"未找到 {name} 的本地文件")

# ── qid (群组管理) 独立函数 ──────────────────────────────────────────────

async def cmd_qid_add(cli_ref, name: str):
    """加入群组（by group_id）。"""
    if not name:
        error("用法: //qid add <group_id>"); return
    if not _is_group_id(name):
        error(f"无效 group_id: {name}（需要 g-xxx.agentid.pub 或 grp_ 格式）"); return
    await cli_ref._join_group_flow(name)

async def cmd_qid_quit(cli_ref, name: str):
    """退出群组。"""
    if not name:
        error("用法: //qid quit <group_id>"); return
    if not _is_group_id(name):
        error(f"无效 group_id: {name}（需要 g-xxx.agentid.pub 或 grp_ 格式）"); return
    gname = cli_ref._get_group_name(name)
    try:
        confirm = await _async_input(f"退出群 {gname}？[y/N] ")
    except (EOFError, KeyboardInterrupt):
        info("已取消"); return
    if confirm.strip().lower() != 'y':
        info("已取消"); return
    try:
        await cli_ref.client.call("group.leave", {"group_id": name})
        # 若当前 target 是被退出的群，清除 target
        if cli_ref.target and _is_group_target(cli_ref.target) and cli_ref.target.get("id") == name:
            cli_ref._clear_target()
        await cli_ref._refresh_group_cache()
        info(f"已退出 {gname}")
    except Exception as e:
        error(f"退出失败: {e}")

async def cmd_qid_search(cli_ref, keyword: str):
    """搜索公开群组。"""
    if not keyword:
        error("用法: //qid search <关键词>"); return
    try:
        result = await cli_ref.client.call("group.search", {"keyword": keyword, "size": 20})
        items = result.get("items", [])
        if not items:
            info("未找到相关群组"); return
        for g in items:
            gid = g.get("group_id", "")
            gname = g.get("name", gid)
            count = g.get("member_count", "?")
            info(f"  {gname}  ({gid})  {count}人")
        info(f"共 {len(items)} 个结果")
    except Exception as e:
        error(f"搜索失败: {e}")

async def main():
    import argparse

    argv_tail = sys.argv[1:]
    if (
        len(argv_tail) >= 5
        and argv_tail[0] == "aid"
        and argv_tail[1] == "new"
        and any(arg in ("-p", "--port") or arg.startswith("--port=") for arg in argv_tail[3:])
    ):
        print(
            "错误：--port 是全局参数，放在子命令后面不会生效。\n"
            f"正确写法：aun -p 20001 aid new {argv_tail[2]}",
            file=sys.stderr,
        )
        raise SystemExit(2)

    parser = argparse.ArgumentParser(
        prog="aun",
        usage="aun [-l AID] [-t AID] [-p PORT] [-s MSG] | aun aid <command> | aun qid <command>",
        description="AUN CLI 工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
options:
  -l, --local AID       本地 AID（默认从 config.json 读取）
  -t, --target AID      目标 AID 或 group_id
  -p, --port PORT       Gateway 端口（覆盖 config）
  -s, --send MSG        发送单条消息后退出
  -L, --log N           打印最后 N 行日志并持续跟随

commands:
  aun aid list               列出本地所有 AID
  aun aid new <aid>          创建新 AID
  aun aid delete <aid>       删除本地 AID
  aun qid add <group_id>     加入群组
  aun qid quit <group_id>    退出群组
  aun qid search <关键词>    搜索公开群组

examples:
  aun -p 20001 aid new alice.agentid.pub               创建 AID（指定 Gateway 端口）
  aun -l my.agentid.pub -t bot.agentid.pub             指定本地和目标 AID 启动
  aun -L 50                                            查看最后 50 行日志并持续跟随
  aun                                                  使用上次的本地 AID 和目标直接启动
  aun -s "你好"                                        发送单条消息后退出""")
    parser._action_groups = []  # 隐藏自动生成的 options/positional 区块
    sub = parser.add_subparsers(dest="subcmd")
    sub.required = False

    aid_p = sub.add_parser("aid", help="AID 管理")
    aid_sub = aid_p.add_subparsers(dest="action")
    aid_sub.add_parser("list", help="列出本地所有 AID")
    aid_new_p = aid_sub.add_parser("new", help="创建新 AID")
    aid_new_p.add_argument("name", help="AID（完整域名，如 alice.agentid.pub）")
    aid_del_p = aid_sub.add_parser("delete", help="删除本地 AID")
    aid_del_p.add_argument("name", help="AID 名称")

    qid_p = sub.add_parser("qid", help="群组管理")
    qid_sub = qid_p.add_subparsers(dest="action")
    qid_add_p = qid_sub.add_parser("add", help="加入群组")
    qid_add_p.add_argument("name", help="group_id（g-xxx.agentid.pub 格式）")
    qid_quit_p = qid_sub.add_parser("quit", help="退出群组")
    qid_quit_p.add_argument("name", help="group_id")
    qid_search_p = qid_sub.add_parser("search", help="搜索公开群组")
    qid_search_p.add_argument("keyword", help="搜索关键词")

    parser.add_argument("--local", "-l", help="本地 AID（默认从 config.json 读取）")
    parser.add_argument("--target", "-t", help="目标 AID 或 group_id")
    parser.add_argument("--send", "-s", help="发送单条消息后退出")
    parser.add_argument("--port", "-p", type=int, metavar="PORT", help="Gateway 端口（覆盖 config）")
    parser.add_argument("--log", "-L", type=int, metavar="N", help="打印最后 N 行日志并持续跟随")

    args, _ = parser.parse_known_args()
    _init_globals()

    _validate_log_mode_args(sys.argv, args.log, args.subcmd)
    if args.log is not None:
        await _follow_log_output(args.log)
        return

    # --port 覆盖 config / env
    if args.port:
        global GATEWAY_URL
        GATEWAY_URL = f"wss://{GATEWAY_HOST}:{args.port}/aun"

    if args.subcmd == "aid":
        if args.action == "list":
            cmd_aid_list()
        elif args.action == "new":
            if _validate_aid(args.name):
                try:
                    await cmd_aid_create(args.name)
                except Exception as e:
                    error(f"创建失败: {e}")
        elif args.action == "delete":
            if _validate_aid(args.name):
                cmd_aid_delete(args.name)
        else:
            aid_p.print_help()
        return

    if args.subcmd == "qid":
        if not args.action:
            qid_p.print_help()
            return
        aid = args.local if hasattr(args, 'local') and args.local else _load_config().get("aid")
        if not aid:
            error("未指定本地 AID，请先创建: aun aid new <aid>"); return
        c = AUNCli(aid=aid)
        try:
            await c.start()
            if args.action == "add":
                await cmd_qid_add(c, args.name)
            elif args.action == "quit":
                await cmd_qid_quit(c, args.name)
            elif args.action == "search":
                await cmd_qid_search(c, args.keyword)
            else:
                qid_p.print_help()
        finally:
            await c.close()
        return

    aid = args.local if args.local else _load_config().get("aid")
    if not aid:
        error("未指定本地 AID，请先创建: aun aid new <aid>")
        return
    if not _validate_aid(aid):
        return

    target = args.target if args.target else None
    if target and not _is_valid_aid(target) and not _is_group_id(target):
        error(f"无效目标: {target}（需要 AID 或 group_id 格式）")
        return

    c = AUNCli(aid=aid, target=target)
    try:
        await c.start()
        if args.send:
            await c.send(args.send)
            info("等待回复 (10s)…")
            await asyncio.sleep(10)
        else:
            await repl(c)
    except KeyboardInterrupt:
        pass
    except SystemExit:
        pass
    except Exception as e:
        error(f"启动失败: {e}")
    finally:
        short_aid = _short_name(c.my_aid or 'unknown')
        _p(f"  {C.DIM}{short_aid} 正在退出…{C.RESET}")
        info("断开连接…")
        await c.close()
        info("已退出")

def cli_main():
    """Entry point for console script"""
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    cli_main()
