"""Tests for v2 multi-level menu completion in AUNCompleter."""
import sys, types
from unittest.mock import MagicMock
from prompt_toolkit.document import Document

# Mock aun_core before importing aun_cli
_aun_core = types.ModuleType('aun_core')
_aun_core.AUNClient = MagicMock
sys.modules['aun_core'] = _aun_core
_keystore = types.ModuleType('aun_core.keystore')
sys.modules['aun_core.keystore'] = _keystore
_file_ks = types.ModuleType('aun_core.keystore.file')
_file_ks.FileKeyStore = MagicMock
sys.modules['aun_core.keystore.file'] = _file_ks
_security = types.ModuleType('aun_core.security')
sys.modules['aun_core.security'] = _security

from aun_cli import AUNCompleter


def _make_cli_ref(menu, sub_menus=None):
    ref = MagicMock()
    ref._pending_menu = menu
    ref._pending_sub_menu = sub_menus or {}
    ref._sub_menu_querying = set()
    ref._menu_querying = False
    ref._menu_cooldown_until = 0
    ref._menu_cached_at = 1e9
    ref._menu_ttl = 300
    ref.connected = True
    ref.target = {"type": "peer", "id": "test.agentid.pub"}

    async def _noop_query(cmd):
        pass
    ref.query_sub_menu = _noop_query
    return ref


V2_MENU = [
    {
        "group": "会话管理",
        "commands": [
            {
                "cmd": "/new",
                "label": "新建会话",
                "args": "名称",
                "next": {"type": "text"},
            },
            {
                "cmd": "/session",
                "label": "会话操作",
                "next": {
                    "type": "select",
                    "items": [
                        {"value": "list", "label": "列出会话"},
                        {
                            "value": "delete",
                            "label": "删除",
                            "next": {"type": "select", "dynamic": True},
                        },
                    ],
                },
            },
        ],
    },
    {
        "group": "Agent 与模型",
        "commands": [
            {
                "cmd": "/model",
                "label": "切换模型",
                "next": {
                    "type": "select",
                    "items": [
                        {"value": "sonnet", "label": "Sonnet"},
                        {"value": "opus", "label": "Opus"},
                        {"value": "haiku", "label": "Haiku"},
                    ],
                },
            },
        ],
    },
    {
        "group": "设置",
        "commands": [
            {"cmd": "/safe", "label": "安全模式"},
        ],
    },
]


def _completions(text, menu=V2_MENU, sub_menus=None):
    c = AUNCompleter(cli_ref=_make_cli_ref(menu, sub_menus))
    doc = Document(text, len(text))
    return list(c.get_completions(doc, None))


def test_first_level_shows_all():
    comps = _completions("/")
    texts = [c.text for c in comps]
    assert any("/new" in t for t in texts)
    assert any("/model" in t for t in texts)
    assert any("/safe" in t for t in texts)
    assert any("/session" in t for t in texts)


def test_first_level_filter():
    comps = _completions("/mo")
    texts = [c.text for c in comps]
    assert any("model" in t for t in texts)
    assert not any("safe" in t for t in texts)


def test_leaf_node_no_trailing_space():
    comps = _completions("/sa")
    for c in comps:
        if "safe" in c.text:
            assert not c.text.endswith(" "), f"/safe should not have trailing space: {c.text!r}"


def test_model_shows_sub_items():
    comps = _completions("/model ")
    texts = [c.text for c in comps]
    assert any("sonnet" in t for t in texts)
    assert any("opus" in t for t in texts)
    assert any("haiku" in t for t in texts)


def test_model_sub_filter():
    comps = _completions("/model s")
    texts = [c.text for c in comps]
    assert any("sonnet" in t for t in texts)
    assert not any("opus" in t for t in texts)


def test_model_leaf_no_trailing_space():
    comps = _completions("/model ")
    for c in comps:
        if "sonnet" in c.text:
            assert not c.text.rstrip().endswith(" "), f"leaf should not trail space"


def test_text_type_shows_hint():
    comps = _completions("/new ")
    assert len(comps) >= 1
    assert any("名称" in (c.display[0][1] if isinstance(c.display, list) else str(c.display)) for c in comps)


def test_session_shows_sub_items():
    comps = _completions("/session ")
    texts = [c.text for c in comps]
    assert any("list" in t for t in texts)
    assert any("delete" in t for t in texts)


def test_session_delete_dynamic_no_cache():
    """动态子菜单无缓存时不产生补全项（等响应到达后再打开）。"""
    comps = _completions("/session delete ")
    assert len(comps) == 0


def test_session_delete_dynamic_cached():
    sub = {"/session delete": [
        {"value": "重构", "label": "重构会话"},
        {"value": "测试", "label": "测试会话"},
    ]}
    comps = _completions("/session delete ", sub_menus=sub)
    texts = [c.text for c in comps]
    assert any("重构" in t for t in texts)
    assert any("测试" in t for t in texts)


def test_old_format_compat():
    """旧格式（label 而非 name）仍然可用，无 desc 时 display_meta 为空。"""
    old_menu = [
        {
            "group": "测试",
            "commands": [
                {"cmd": "/help", "label": "帮助"},
            ],
        },
    ]
    comps = _completions("/", menu=old_menu)
    texts = [c.text for c in comps]
    assert any("help" in t for t in texts)
    metas = [str(c.display_meta) for c in comps if "help" in c.text]
    assert all('帮助' not in m for m in metas)
