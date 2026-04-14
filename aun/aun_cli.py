#!/usr/bin/env python3
"""AUN CLI 工具 — 交互式命令行客户端"""

import asyncio
import json
import os
import re
import signal
import sys
from io import StringIO
from pathlib import Path
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ── 依赖自检 ──────────────────────────────────────────────────────────────
_REQUIRED_PACKAGES = {
    "aun_core": "aun-core>=0.1.5",
    "prompt_toolkit": "prompt-toolkit>=3.0.0",
    "rich": "rich>=13.0.0",
}

def _ensure_deps():
    """检查第三方依赖，缺失时自动 pip install，完成后重启进程。"""
    missing = []
    for mod, pkg in _REQUIRED_PACKAGES.items():
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if not missing:
        return
    print(f"[aun] 正在安装缺失依赖: {', '.join(missing)} ...")
    import subprocess
    sources = [
        ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--trusted-host", "pypi.tuna.tsinghua.edu.cn"],
        [],  # 默认 PyPI
    ]
    for i, src_args in enumerate(sources):
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "-q", *src_args, *missing],
                stdout=sys.stdout, stderr=sys.stderr,
            )
            break
        except subprocess.CalledProcessError:
            if i < len(sources) - 1:
                print("[aun] 镜像源安装失败，尝试默认源 ...")
            else:
                print("[aun] 依赖安装失败，请手动安装:", " ".join(missing))
                raise SystemExit(1)
    # 安装完成后重启自身，确保新包对进程可见
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
HISTORY_FILE = None
_CONFIG_FILE = None

def _init_globals():
    """初始化全局配置变量。"""
    global AUN_PATH, DATA_DIR, HISTORY_FILE, _CONFIG_FILE, GATEWAY_URL
    env = os.environ.get("AUN_CLI_DATA", "").strip()
    base = Path(env) if env else Path.home() / ".aun"
    AUN_PATH = base
    DATA_DIR = base / "aun-cli"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
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
    """判断字符串是否为 group_id（以 grp_ 开头）。"""
    return bool(value) and value.startswith("grp_")

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
    """从配置加载 recent_targets，兼容旧 recent_peers 格式。"""
    # 新格式优先
    targets = cfg.get("recent_targets", [])
    if targets and isinstance(targets[0], dict):
        return [t for t in targets if isinstance(t, dict) and t.get("type")]
    # 旧格式迁移
    peers = cfg.get("recent_peers", [])
    return [{"type": "peer", "id": p, "name": _short_name(p)} for p in peers if p]

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
    ("//plain",      "",    "切换 明文/E2EE"),
    ("//target",     "aid", "设置目标（或用 @）"),
    ("//ping",       "",    "Ping 网关"),
    ("//processing", "",    "当前处理状态"),
    ("//rawdata",    "",    "最后消息原始内容"),
    ("//e2ee",       "",    "E2EE 状态"),
    ("//status",     "",    "连接状态"),
    ("//aid",        "cmd", "AID 管理"),
    ("//help",       "",    "帮助"),
    ("//quit",       "",    "退出"),
]

# 群命令表: (命令名, 别名列表, 描述, 需要当前群, 菜单可见)
_GROUP_COMMANDS = [
    ("create",   ["add"],    "创建群组",                        False, True),
    ("list",     ["ls"],     "列出我的群组",                    False, True),
    ("search",   ["so"],     "搜索公开群组",                    False, True),
    ("info",     [],         "群组信息",                        True,  True),
    ("name",     [],         "修改群名",                        True,  True),
    ("desc",     [],         "修改群描述",                      True,  True),
    ("notice",   [],         "查看/更新公告",                   True,  True),
    ("rules",    [],         "查看/更新规则",                   True,  True),
    ("role",     [],         "设置成员角色",                    True,  True),
    ("transfer", [],         "转让群主",                        True,  True),
    ("quit",     [],         "退出群组",                        True,  True),
    ("suspend",  [],         "暂停群组",                        True,  True),
    ("resume",   [],         "恢复群组",                        True,  True),
    ("user",     ["u"],      "成员列表（查看u 添加u+ 踢出u-）",   True,  True),
    ("user+",    ["u+"],     "添加成员",                          True,  False),
    ("user-",    ["u-"],     "踢出成员",                          True,  False),
    ("invite",   ["inv"],    "邀请码（查看inv 创建inv+ 撤销inv-）", True, True),
    ("invite+",  ["inv+"],   "创建邀请码",                        True,  False),
    ("invite-",  ["inv-"],   "撤销邀请码",                        True,  False),
    ("request",  ["req"],    "入群申请（列表req 批准req+ 拒绝req-）", True, True),
    ("request+", ["req+"],   "批准入群申请",                      True,  False),
    ("request-", ["req-"],   "拒绝入群申请",                      True,  False),
    ("ban",      [],         "封禁成员（列表ban 封禁ban+ 解封ban-）", True, True),
    ("ban+",     [],         "封禁成员",                          True,  False),
    ("ban-",     [],         "解封成员",                          True,  False),
]

# 构建命令查找表: name/alias → (cmd_name, need_group)
_GROUP_CMD_LOOKUP = {}
for _cn, _aliases, _desc, _ng, _vis in _GROUP_COMMANDS:
    _GROUP_CMD_LOOKUP[_cn] = (_cn, _ng)
    for _a in _aliases:
        _GROUP_CMD_LOOKUP[_a] = (_cn, _ng)

async def _async_input(prompt_text: str) -> str:
    """在 asyncio 环境中异步读取用户输入。"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: input(prompt_text))

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

        # @ 前缀：统一目标切换（peer + group）
        if text[0] == '@':
            targets = _get_recent_targets()
            # 补充 group cache 中不在 recent 中的群
            group_cache = self.cli_ref._group_cache if self.cli_ref else []
            recent_ids = {t.get("id") for t in targets}
            extra_groups = []
            for g in (group_cache or []):
                gid = g.get("group_id", "")
                if gid and gid not in recent_ids:
                    extra_groups.append({"type": "group", "id": gid, "name": g.get("name", gid)})
            all_targets = targets + extra_groups
            if not all_targets:
                yield Completion("@", start_position=-len(text),
                                 display="(无最近联系人)", display_meta="使用 @aid 或 @group_id")
                return
            after_at = text[1:]
            if ' ' in after_at:
                return  # 目标已选定，后面是消息
            filter_text = after_at.lower()
            current_id = self.cli_ref.target.get("id") if self.cli_ref and self.cli_ref.target else None
            for t in all_targets:
                tid = t.get("id", "")
                tname = t.get("name", "")
                ttype = t.get("type", "")
                is_current = " ✓" if tid == current_id else ""
                if ttype == "peer":
                    display = f"{tname}{is_current}"
                    meta = tid
                else:
                    display = f"{tname}{is_current}"
                    meta = tid
                if filter_text and not (tname.lower().startswith(filter_text) or tid.lower().startswith(filter_text)):
                    continue
                yield Completion(f"@{tid} ", start_position=-len(text),
                                 display=display, display_meta=meta)
            return

        if text[0] != '/':
            return

        # // 前缀：本地命令菜单
        if text.startswith("//"):
            filter_text = text[2:]
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
            for cmd_name, aliases, _desc, _need_group, _visible in _GROUP_COMMANDS:
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
        self.encrypt    = cfg.get("encrypt", True)   # 当前收发模式：True=E2EE, False=明文
        self.rejected   = 0        # 因加密模式不匹配而拒收的消息数
        self._last_sent = None     # 最近发送时间
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
        # 数据日志
        self._log_enabled = cfg.get("log", False)  # 从 config 恢复
        self._log_file = None           # 日志文件句柄
        self._log_date = None           # 当前日志文件对应的日期字符串

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

        info(f"AID: {C.BOLD}{aid}{C.RESET}")

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

        # 尝试解析 processing 状态通知
        proc_payload = payload
        if isinstance(proc_payload, str):
            try:
                proc_payload = json.loads(proc_payload)
            except (json.JSONDecodeError, TypeError):
                proc_payload = None
        if isinstance(proc_payload, dict) and proc_payload.get("type") == "processing":
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
            return  # 不作为普通消息展示

        if isinstance(proc_payload, dict) and proc_payload.get("type") == "menu.response":
            self._pending_menu = proc_payload.get("items", [])
            self._menu_cached_at = asyncio.get_event_loop().time()
            self._menu_fresh = True  # 通知 _wait_menu_response 收到新数据
            return

        # 忽略 menu.query（对端也是 CLI 时会收到，不作为普通消息展示）
        if isinstance(proc_payload, dict) and proc_payload.get("type") == "menu.query":
            return

        text = payload.get("text", json.dumps(payload, ensure_ascii=False)) \
               if isinstance(payload, dict) else str(payload)

        # 更新最近消息的加密状态（供 /e2ee 调试命令使用）
        msg_encrypted = bool(e2ee)
        self.last_e2ee = "🔒 E2EE" if msg_encrypted else "🔓 明文"

        # 加密模式不匹配 → 本地拒收
        if msg_encrypted != self.encrypt:
            self.rejected += 1
            expect = "E2EE" if self.encrypt else "明文"
            got    = "E2EE" if msg_encrypted else "明文"
            print_status(from_aid, "✗", C.RED, f"本地拒收（收到{got}，期望{expect}）")
            return

        self.msg_count += 1
        _record_target({"type": "peer", "id": from_aid, "name": _short_name(from_aid)})

        # debug: 收到第一条回复数据时显示延迟
        if self.debug_mode and self._last_sent is not None:
            delay_ms = int((asyncio.get_event_loop().time() - self._last_sent) * 1000)
            print_status(from_aid, "·", C.DIM, f"准备输出 ({delay_ms}ms)")
            self._last_sent = None  # 只显示一次

        # silent send 抑制回复（如 Ctrl+C 中断的 /stop 响应）
        if self._suppress_next:
            self._suppress_next = False
            return

        extra = ""
        if task_id: extra += f"  {C.DIM}[task:{task_id}]\033[22m"

        print_recv(from_aid, text, extra)

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
                    "encrypt": encrypt, "persist": False,
                })
            self._last_sent = asyncio.get_event_loop().time()
            _record_target(self.target)
            # 数据日志
            self._log_write("SEND", {
                "to": target_id, "text": text,
                "encrypt": encrypt, "result": result,
            })
            status = result.get("status") if isinstance(result, dict) else None
            label = "已送达" if status == "delivered" else "已发送"
            if self.debug_mode:
                ms = int((self._last_sent - t0) * 1000)
                print_status(target_label, "▶", C.YELLOW, f"{label} ({ms}ms)")
            # 发新消息时清理旧的 processing 状态
            self._processing.clear()
            if text != '/stop':
                self._proc_start.clear()
        except asyncio.TimeoutError:
            self._suppress_next = False
            print_status(target_label, "x", C.RED, "发送超时")
        except Exception as e:
            self._suppress_next = False
            print_status(target_label, "x", C.RED, f"发送失败: {e}")

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
                "encrypt": True, "persist": False,
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

    async def set_peer_target(self, name: str) -> bool:
        """校验 AID → 查询 Gateway → 设为 peer 目标并持久化。成功返回 True。"""
        if not _validate_aid(name):
            return False
        info(f"正在验证 {name} …")
        if not await _aid_exists(name):
            error(f"AID 不存在或 Gateway 不可达: {name}")
            return False
        target = {"type": "peer", "id": name, "name": _short_name(name)}
        self.target = target
        _record_target(target)
        cfg = _load_config()
        cfg["target"] = target
        _save_config(cfg)
        info(f"目标: {name}")
        self._pending_menu = None
        asyncio.ensure_future(self.query_menu())
        return True

    def set_group_target(self, group_id: str, group_name: str = None) -> bool:
        """设为 group 目标并持久化。"""
        name = group_name or group_id
        target = {"type": "group", "id": group_id, "name": name}
        self.target = target
        _record_target(target)
        cfg = _load_config()
        cfg["target"] = target
        _save_config(cfg)
        info(f"目标: [{name}]")
        self._pending_menu = None  # 群不支持远端菜单
        return True

    async def resolve_and_switch_target(self, value: str, message: str = "") -> bool:
        """解析 @ 后的值并切换目标。支持 AID、group_id、群名。"""
        # AID 格式
        if _is_valid_aid(value):
            if not await self.set_peer_target(value):
                return False
            if message:
                await self.send(message, encrypt=self.encrypt)
            return True
        # group_id 格式
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
        try:
            result = await self.client.call("group.get_join_requirements", {"group_id": group_id})
        except Exception as e:
            error(f"查询失败: {e}")
            return False
        reqs = result.get("join_requirements", {})
        mode = reqs.get("mode", "closed")
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
        # open / approval
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

        # 提取文本
        if isinstance(payload, dict):
            text = payload.get("text", json.dumps(payload, ensure_ascii=False))
        elif isinstance(payload, str):
            text = payload
        else:
            text = str(payload)

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

        # 群名
        group_name = self._get_group_name(group_id)
        sender_name = _short_name(sender_aid)

        # 记录到最近目标
        _record_target({"type": "group", "id": group_id, "name": group_name})

        self.msg_count += 1
        text = _replace_emoji(text)
        rendered = _render_md(text)
        lines = rendered.rstrip().split('\n')
        header = f"{C.DIM}{ts}\033[22m {C.GREEN}◀ [{group_name}] {sender_name}\033[39m"
        if len(lines) > 1:
            _p(header)
            for line in lines:
                _p(line)
        else:
            _p(f"{header}  {lines[0]}")

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
        """分发 # 群命令。"""
        handler = getattr(self, f"_cmd_group_{cmd_name.replace('-', '_').replace('+', '_add').replace('user_add', 'user_add').replace('user-', 'user_kick')}", None)
        # 用查找表映射
        method_map = {
            "create": "_cmd_group_create",
            "list": "_cmd_group_list",
            "search": "_cmd_group_search",
            "info": "_cmd_group_info",
            "name": "_cmd_group_name",
            "desc": "_cmd_group_desc",
            "notice": "_cmd_group_notice",
            "rules": "_cmd_group_rules",
            "role": "_cmd_group_role",
            "transfer": "_cmd_group_transfer",
            "quit": "_cmd_group_quit",
            "suspend": "_cmd_group_suspend",
            "resume": "_cmd_group_resume",
            "user": "_cmd_group_user",
            "user+": "_cmd_group_user_add",
            "user-": "_cmd_group_user_kick",
            "invite": "_cmd_group_invite_list",
            "invite+": "_cmd_group_invite_create",
            "invite-": "_cmd_group_invite_revoke",
            "request": "_cmd_group_request_list",
            "request+": "_cmd_group_request_approve",
            "request-": "_cmd_group_request_reject",
            "ban": "_cmd_group_ban_list",
            "ban+": "_cmd_group_ban_add",
            "ban-": "_cmd_group_ban_remove",
        }
        method_name = method_map.get(cmd_name)
        if not method_name:
            error(f"未知群命令: #{cmd_name}")
            return
        method = getattr(self, method_name, None)
        if not method:
            error(f"命令未实现: #{cmd_name}")
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
        try:
            result = await self.client.call("group.get", {"group_id": self.target["id"]})
            g = result.get("group", {})
            info(f"  名称:     {g.get('name', '?')}")
            info(f"  ID:       {g.get('group_id', '?')}")
            info(f"  群主:     {g.get('owner_aid', '?')}")
            info(f"  可见性:   {g.get('visibility', '?')}")
            info(f"  状态:     {g.get('status', '?')}")
            info(f"  成员数:   {g.get('member_count', '?')}")
            info(f"  消息序号: {g.get('message_seq', 0)}")
            desc = g.get("description", "")
            if desc:
                info(f"  描述:     {desc}")
        except Exception as e:
            error(f"查询失败: {e}")

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
        if not self._require_group_target(): return
        gid = self.target["id"]
        if not arg.strip():
            try:
                result = await self.client.call("group.get_rules", {"group_id": gid})
                rules = result.get("rules", result.get("requirements", {}))
                info(f"  加入模式: {rules.get('mode', '?')}")
                q = rules.get("question", "")
                if q:
                    info(f"  入群问题: {q}")
            except Exception as e:
                error(f"查询失败: {e}")
        else:
            # #rules mode=approval question=xxx
            params = {"group_id": gid}
            for kv in arg.strip().split():
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    params[k] = v
            try:
                await self.client.call("group.update_rules", params)
                info("规则已更新")
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
            try:
                choice = await _async_input("请选择 [1/2]: ")
            except (EOFError, KeyboardInterrupt):
                info("已取消"); return
            if choice.strip() == "1":
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

    async def _cmd_group_user(self, arg: str):
        if not self._require_group_target(): return
        try:
            result = await self.client.call("group.get_members", {"group_id": self.target["id"], "size": 200})
            members = result.get("members", [])
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
            error("用法: /u+ <aid>"); return
        try:
            await self.client.call("group.add_member", {"group_id": self.target["id"], "aid": aid})
            info(f"已添加成员 {_short_name(aid)}")
        except Exception as e:
            error(f"添加失败: {e}")

    async def _cmd_group_user_kick(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /u- <aid>"); return
        try:
            await self.client.call("group.kick", {"group_id": self.target["id"], "aid": aid})
            info(f"已移除成员 {_short_name(aid)}")
        except Exception as e:
            error(f"移除失败: {e}")

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
            error("用法: /inv- <code>"); return
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
            error("用法: /req+ <aid>"); return
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
            error("用法: /req- <aid>"); return
        try:
            await self.client.call("group.review_join_request", {
                "group_id": self.target["id"], "aid": aid, "approve": False,
            })
            info(f"已拒绝 {_short_name(aid)} 的入群申请")
        except Exception as e:
            error(f"操作失败: {e}")

    async def _cmd_group_ban_list(self, arg: str):
        if not self._require_group_target(): return
        try:
            result = await self.client.call("group.get_banlist", {"group_id": self.target["id"]})
            items = result.get("items", [])
            if not items:
                info("暂无封禁成员"); return
            for b in items:
                aid = b.get("aid", "?")
                info(f"  {_short_name(aid)}  ({aid})")
        except Exception as e:
            error(f"查询失败: {e}")

    async def _cmd_group_ban_add(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /ban+ <aid>"); return
        try:
            await self.client.call("group.ban", {"group_id": self.target["id"], "aid": aid})
            info(f"已封禁 {_short_name(aid)}")
        except Exception as e:
            error(f"封禁失败: {e}")

    async def _cmd_group_ban_remove(self, arg: str):
        if not self._require_group_target(): return
        aid = arg.strip()
        if not aid:
            error("用法: /ban- <aid>"); return
        try:
            await self.client.call("group.unban", {"group_id": self.target["id"], "aid": aid})
            info(f"已解封 {_short_name(aid)}")
        except Exception as e:
            error(f"解封失败: {e}")

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
        if isinstance(data, dict):
            self._log_write("EVENT", {"type": "message.ack", **data})
            from_aid = data.get("from", self.target["id"] if self.target else "?")
            if self.debug_mode:
                seq = data.get("seq", "?")
                print_status(from_aid, "✓✓", C.DIM, f"已送达 seq={seq}")
            else:
                print_status(from_aid, "✓✓", C.DIM, "已送达")

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
        if self.rejected:
            info(f"本地拒收: {self.rejected}")
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

async def _show_help():
    await _msg_dialog(
        title=HTML('<style bg="#2a3a4a" fg="#ffff00"> AUN CLI </style>'),
        text=HTML(
            '<b>快捷键</b>\n'
            '  <ansiyellow>/</ansiyellow>              命令菜单（peer→远端 群→群管理）\n'
            '  <ansiyellow>//</ansiyellow>             本地命令菜单\n'
            '  <ansiyellow>@</ansiyellow>              切换目标（peer / 群组）\n'
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
            '  <ansiyellow>@target msg</ansiyellow>    切换并发消息\n\n'
            '<b>群命令（目标为群时 / 触发）</b>\n'
            '  <ansiyellow>/ls</ansiyellow>            列出我的群\n'
            '  <ansiyellow>/add</ansiyellow>           创建群组\n'
            '  <ansiyellow>/so query</ansiyellow>      搜索公开群\n'
            '  <ansiyellow>/info</ansiyellow>          群信息\n'
            '  <ansiyellow>/u</ansiyellow>             成员列表\n'
            '  <ansiyellow>/u+ aid</ansiyellow>        添加成员\n'
            '  <ansiyellow>/u- aid</ansiyellow>        踢出成员\n'
            '  <ansiyellow>/inv</ansiyellow>           邀请码列表\n'
            '  <ansiyellow>/inv+</ansiyellow>          创建邀请码\n'
            '  <ansiyellow>/quit</ansiyellow>          退出群组'
        ),
        style=_HELP_STYLE,
    )

async def repl(c: AUNCli):
    await _show_help()
    _p(f"  {C.DIM}直接输入文本发送消息{C.RESET}")
    def toolbar():
        if _ctrlc_state['hint']:
            return HTML(f" <b>{_ctrlc_state['hint']}</b>")
        conn = "🟢 已连接" if c.connected else "🔴 未连接"
        tgt  = _target_label(c.target) if c.target else "未设置"
        me   = c.my_aid
        enc  = "🔒 E2EE" if c.encrypt else "🔓 明文"
        rej  = f"拒收: {c.rejected}  " if c.rejected else ""
        dbg  = "  [DEBUG]" if c.debug_mode else ""
        log  = "  [LOG]" if c._log_enabled else ""
        return HTML(f" <b>{conn}</b>  {me}  →  {tgt}  消息: {c.msg_count}  {rej}{enc}{dbg}{log}")

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

            # @ 前缀：统一目标切换（peer + group）
            if line.startswith("@"):
                rest = line[1:]
                parts = rest.split(None, 1)
                name = parts[0] if parts else ""
                message = parts[1] if len(parts) > 1 else ""
                if not name:
                    continue
                if not await c.resolve_and_switch_target(name, message):
                    continue
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
                    c.rejected = 0
                    cfg = _load_config()
                    cfg["encrypt"] = c.encrypt
                    _save_config(cfg)
                    mode = "🔒 E2EE" if c.encrypt else "🔓 明文"
                    info(f"收发模式: {mode}")
                elif cmd == "debug":
                    c.cmd_debug()
                elif cmd == "log":
                    c.cmd_log()
                elif cmd == "processing":
                    await c.cmd_processing()
                elif cmd == "rawdata":
                    await c.cmd_rawdata()
                elif cmd == "e2ee":
                    c.cmd_e2ee()
                elif cmd == "help":
                    await _show_help()
                elif cmd == "aid":
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
                    else:
                        error("用法: //aid list | new <aid> | delete <aid>")
                else:
                    error(f"未知命令: //{cmd}")
                continue

            if line.startswith("/") and not line.startswith("//"):
                # / 前缀：group target → 群命令，peer target → 远端转发
                if c.target and _is_group_target(c.target):
                    rest = line[1:]
                    parts = rest.split(None, 1)
                    cmd_input = parts[0] if parts else ""
                    arg = parts[1] if len(parts) > 1 else ""
                    if cmd_input:
                        lookup = _GROUP_CMD_LOOKUP.get(cmd_input)
                        if lookup:
                            cmd_name, need_group = lookup
                            if need_group and not c._require_group_target():
                                continue
                            await c._dispatch_group_cmd(cmd_name, arg)
                            continue
                        else:
                            error(f"未知群命令: /{cmd_input}")
                            continue
                # peer target 或 target 未设置：转发到远端
                await c.send(line)
                continue
            else:
                await c.send(line, encrypt=c.encrypt)

def _load_history():
    from prompt_toolkit.history import FileHistory, InMemoryHistory
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        return FileHistory(str(HISTORY_FILE))
    except Exception:
        return InMemoryHistory()

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
        error(f"AID {name} 已存在"); return
    result = await client.auth.create_aid({"aid": name})
    info(f"AID 创建成功: {result['aid']}")
    cfg = _load_config()
    if not cfg.get("aid"):
        cfg["aid"] = name
        _save_config(cfg)
        info("已设为默认 AID")

def cmd_aid_delete(name: str):
    ks = _get_keystore()
    local = ks.load_identity(name)
    if local is None:
        error(f"AID {name} 不存在"); return
    confirm = input(f"删除 {name}？[y/N] ").strip().lower()
    if confirm != 'y':
        info("已取消"); return
    ks.delete_identity(name)
    cfg = _load_config()
    if cfg.get("aid") == name:
        del cfg["aid"]
        _save_config(cfg)
    info(f"已删除 {name}")

async def main():
    import argparse
    parser = argparse.ArgumentParser(
        prog="aun",
        usage="aun [-a NAME] [-t NAME] [-s MSG] | aun aid <command>",
        description="AUN CLI 工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
options:
  -a, --aid AID         本地 AID（默认从 config.json 读取）
  -t, --target AID      目标 AID
  -s, --send MSG        发送单条消息后退出

commands:
  aun aid list              列出本地所有 AID
  aun aid new <aid>         创建新 AID
  aun aid delete <aid>      删除本地 AID

examples:
  aun aid new alice.agentid.pub -p 20001  创建 AID（指定 Gateway 端口）
  aun -a my.agentid.pub -t bot.agentid.pub  指定本地和目标 AID 启动
  aun                              使用上次的 AID 和目标直接启动
  aun -s "你好"                    发送单条消息后退出""")
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

    parser.add_argument("--aid", "-a", help="本地 AID（默认从 config.json 读取）")
    parser.add_argument("--target", "-t", help="目标 AID 或 group_id")
    parser.add_argument("--send", "-s", help="发送单条消息后退出")
    parser.add_argument("--port", "-p", type=int, help="Gateway 端口（覆盖 config）")

    args, _ = parser.parse_known_args()
    _init_globals()

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

    aid = args.aid if args.aid else _load_config().get("aid")
    if not aid:
        error("未指定 AID，请先创建: aun aid new <aid>")
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
    asyncio.run(main())

if __name__ == "__main__":
    cli_main()
