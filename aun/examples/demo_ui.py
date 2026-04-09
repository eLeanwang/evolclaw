#!/usr/bin/env python3
"""prompt_toolkit UI 功能演示 — 展示所有可用的交互组件"""

import asyncio
import time
from datetime import datetime

from prompt_toolkit import Application, PromptSession
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import Completer, Completion, WordCompleter
from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import ANSI, HTML, FormattedText, merge_formatted_text
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout.containers import (
    Float, FloatContainer, HSplit, VSplit, Window, WindowAlign,
)
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.layout import Layout
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.output import ColorDepth
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.shortcuts import (
    ProgressBar,
    button_dialog,
    checkboxlist_dialog,
    input_dialog,
    message_dialog,
    radiolist_dialog,
    yes_no_dialog,
    print_formatted_text,
)
from prompt_toolkit.shortcuts.progress_bar import formatters
from prompt_toolkit.styles import Style
from prompt_toolkit.validation import Validator
from prompt_toolkit.widgets import (
    Box, Button, Dialog, Frame, Label, RadioList, TextArea,
)

# ── 通用样式 ──────────────────────────────────────────────────────────────

DEMO_STYLE = Style.from_dict({
    "dialog":              "bg:#1a1a2e",
    "dialog frame.label":  "bg:#e94560 #ffffff bold",
    "dialog.body":         "bg:#16213e #e0e0e0",
    "dialog shadow":       "bg:#0a0a1a",
    "button":              "bg:#e94560 #ffffff",
    "button.focused":      "bg:#ff6b6b #ffffff bold",
    "radiolist":           "#e0e0e0",
    "checkbox":            "#e0e0e0",
    "progress-bar":        "bg:#1a1a2e",
    "progress-bar.used":   "bg:#e94560",
    "frame":               "#e94560",
    "frame.border":        "#e94560",
    "frame.label":         "#ff6b6b bold",
    "text-area":           "bg:#16213e #e0e0e0",
    "label":               "#ff6b6b bold",
    "prompt":              "bg:#2a3a4a #ffff00 bold",
    "bottom-toolbar":      "bg:#1a1a2e #aaaaaa",
    "completion-menu":                   "bg:#1a1a2e #e0e0e0",
    "completion-menu.completion":        "bg:#1a1a2e #e0e0e0",
    "completion-menu.completion.current": "bg:#e94560 #ffffff bold",
    "completion-menu.meta":              "#888888",
    "completion-menu.meta.current":      "#ffffff",
})

C_CYAN   = "\033[36m"
C_GREEN  = "\033[92m"
C_YELLOW = "\033[93m"
C_RED    = "\033[91m"
C_DIM    = "\033[2m"
C_BOLD   = "\033[1m"
C_RESET  = "\033[0m"
C_BG     = "\033[48;2;14;22;41m"

def _p(s):
    print_formatted_text(ANSI(s), color_depth=ColorDepth.TRUE_COLOR)

def banner(title):
    w = 60
    _p(f"\n{C_BG}{C_YELLOW}{'─' * w}{C_RESET}")
    _p(f"{C_BG}{C_YELLOW}  {C_BOLD}{title}{C_RESET}")
    _p(f"{C_BG}{C_YELLOW}{'─' * w}{C_RESET}\n")

def info(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    _p(f"{C_DIM}{ts}{C_RESET} {C_CYAN}·{C_RESET} {msg}")

def result(label, value):
    _p(f"  {C_GREEN}→{C_RESET} {label}: {C_BOLD}{value}{C_RESET}")

def pause():
    input(f"\n{C_DIM}  按 Enter 继续下一个 demo …{C_RESET}\n")

# ══════════════════════════════════════════════════════════════════════════
# 1. 对话框系列 (Dialog Shortcuts)
# ══════════════════════════════════════════════════════════════════════════

def demo_message_dialog():
    banner("1. Message Dialog — 消息弹窗")
    info("最简单的弹窗，用于展示信息")

    message_dialog(
        title=HTML('<style bg="#e94560" fg="white"> AUN Demo </style>'),
        text="欢迎体验 prompt_toolkit 全功能演示！\n\n"
             "本 demo 将展示所有可用的 UI 组件：\n"
             "  · 对话框 (Dialog)\n"
             "  · 输入框 (Input)\n"
             "  · 单选/多选 (RadioList / CheckboxList)\n"
             "  · 进度条 (ProgressBar)\n"
             "  · 全屏应用 (Full-screen App)\n"
             "  · 自动补全 (Completion)\n"
             "  · 底栏工具条 (Bottom Toolbar)\n"
             "  · 表单验证 (Validation)\n"
             "  · 富文本输出 (Formatted Text)\n\n"
             "按 Enter 开始 →",
        style=DEMO_STYLE,
    ).run()


def demo_yes_no_dialog():
    banner("2. Yes/No Dialog — 确认弹窗")
    info("二元选择，返回 True/False")

    answer = yes_no_dialog(
        title="确认操作",
        text="是否启用 E2EE 端到端加密？\n\n"
             "启用后所有消息将自动加密传输。",
        yes_text="启用 🔒",
        no_text="跳过",
        style=DEMO_STYLE,
    ).run()

    result("选择", "启用 E2EE" if answer else "跳过")


def demo_button_dialog():
    banner("3. Button Dialog — 多按钮弹窗")
    info("支持多个自定义按钮，每个返回不同值")

    answer = button_dialog(
        title="选择连接模式",
        text="请选择 AUN 网关连接方式：",
        buttons=[
            ("WebSocket (推荐)", "ws"),
            ("HTTP Long-Poll", "http"),
            ("TCP Direct", "tcp"),
            ("取消", None),
        ],
        style=DEMO_STYLE,
    ).run()

    result("连接模式", answer or "已取消")


def demo_input_dialog():
    banner("4. Input Dialog — 输入弹窗")
    info("文本输入框，支持密码模式")

    # 普通输入
    name = input_dialog(
        title="设置 AID",
        text="请输入你的 Agent ID 名称：\n(例如: alice, bob, my-agent)",
        style=DEMO_STYLE,
    ).run()

    if name:
        result("AID", f"{name}.agentid.pub")
    else:
        result("AID", "已取消")

    # 密码输入
    secret = input_dialog(
        title="密钥保护",
        text="设置 Seed 密码（用于保护私钥）：",
        password=True,
        style=DEMO_STYLE,
    ).run()

    result("密码", "已设置" if secret else "已跳过")


def demo_radiolist_dialog():
    banner("5. RadioList Dialog — 单选弹窗")
    info("单选列表，方向键选择，Tab 切换到按钮")

    answer = radiolist_dialog(
        title="选择模型",
        text="为 EvolClaw Agent 选择 AI 模型：",
        values=[
            ("opus",    "Claude Opus 4.6      (最强推理)"),
            ("sonnet",  "Claude Sonnet 4.6    (均衡选择)"),
            ("haiku",   "Claude Haiku 4.5     (快速响应)"),
        ],
        default="sonnet",
        style=DEMO_STYLE,
    ).run()

    result("模型", answer or "已取消")


def demo_checkboxlist_dialog():
    banner("6. CheckboxList Dialog — 多选弹窗")
    info("多选列表，空格键选中/取消，可选多项")

    answers = checkboxlist_dialog(
        title="启用频道",
        text="选择要启用的消息频道 (空格键选择)：",
        values=[
            ("feishu",  "飞书 (Feishu) — WebSocket 推送"),
            ("wechat",  "微信 (WeChat) — HTTP 长轮询"),
            ("aun",     "AUN 协议 — P2P 加密通信"),
            ("slack",   "Slack — Bot API"),
            ("discord", "Discord — Gateway"),
        ],
        default_values=["feishu", "aun"],
        style=DEMO_STYLE,
    ).run()

    result("已启用", ", ".join(answers) if answers else "无")


def demo_styled_dialog():
    banner("7. Styled Dialog — 自定义样式弹窗")
    info("使用 HTML 富文本 + 自定义 Style 美化弹窗")

    custom_style = Style.from_dict({
        "dialog":              "bg:#0d1117",
        "dialog frame.label":  "bg:#238636 #ffffff bold",
        "dialog.body":         "bg:#161b22 #c9d1d9",
        "dialog shadow":       "bg:#010409",
        "button":              "bg:#238636 #ffffff",
        "button.focused":      "bg:#2ea043 #ffffff bold",
    })

    message_dialog(
        title=HTML('<style fg="#58a6ff">GitHub Style</style> Dialog'),
        text=HTML(
            '<style fg="#58a6ff" bold="true">prompt_toolkit</style> 支持完全自定义样式：\n\n'
            '  <style fg="#f0883e">·</style> 背景色、前景色、边框色\n'
            '  <style fg="#f0883e">·</style> 按钮样式（普通 / 聚焦）\n'
            '  <style fg="#f0883e">·</style> 对话框阴影\n'
            '  <style fg="#f0883e">·</style> HTML 行内样式\n'
            '  <style fg="#f0883e">·</style> ANSI 转义码\n\n'
            '<style fg="#8b949e">所有颜色支持 #RRGGBB 真彩色</style>'
        ),
        style=custom_style,
    ).run()


# ══════════════════════════════════════════════════════════════════════════
# 2. 进度条 (Progress Bar)
# ══════════════════════════════════════════════════════════════════════════

def demo_progress_bar():
    banner("8. Progress Bar — 进度条")
    info("内置进度条，支持多任务、自定义格式")

    pb_style = Style.from_dict({
        "label":       "bg:#e94560 #ffffff",
        "percentage":  "#ff6b6b bold",
        "current":     "#e94560",
        "bar":         "",
        "time-left":   "#888888",
    })

    custom_formatters = [
        formatters.Label(),
        formatters.Text(": [", style="class:percentage"),
        formatters.Percentage(),
        formatters.Text("]", style="class:percentage"),
        formatters.Text(" "),
        formatters.Bar(sym_a="█", sym_b="█", sym_c="░"),
        formatters.Text("  "),
        formatters.TimeLeft(),
    ]

    info("单任务进度条：")
    with ProgressBar(style=pb_style, formatters=custom_formatters) as pb:
        for _ in pb(range(100), label="连接网关"):
            time.sleep(0.02)

    info("多任务并行进度条：")
    with ProgressBar(style=pb_style, formatters=custom_formatters) as pb:
        tasks = [
            (pb(range(80),  label="认证"),       0.03),
            (pb(range(120), label="同步密钥"),    0.02),
            (pb(range(60),  label="加载会话"),    0.04),
        ]
        iterators = [iter(t) for t, _ in tasks]
        delays    = [d for _, d in tasks]
        active = list(range(len(iterators)))
        while active:
            for i in list(active):
                try:
                    next(iterators[i])
                    time.sleep(delays[i])
                except StopIteration:
                    active.remove(i)


# ══════════════════════════════════════════════════════════════════════════
# 3. Prompt Session 高级功能
# ══════════════════════════════════════════════════════════════════════════

def demo_completion():
    banner("9. Auto-Completion — 自动补全")
    info("输入 / 触发命令补全，输入 @ 触发 AID 补全")
    info("输入 done 结束本 demo\n")

    class DemoCompleter(Completer):
        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
            if text.startswith("/"):
                prefix = text[1:]
                cmds = [
                    ("/help",    "显示帮助"),
                    ("/target",  "设置目标 AID"),
                    ("/ping",    "Ping 网关"),
                    ("/status",  "连接状态"),
                    ("/debug",   "调试模式"),
                    ("/plain",   "切换 E2EE/明文"),
                    ("/e2ee",    "E2EE 状态"),
                    ("/quit",    "退出"),
                ]
                for cmd, meta in cmds:
                    if cmd[1:].startswith(prefix):
                        yield Completion(cmd, start_position=-len(text),
                                         display=cmd, display_meta=meta)
            elif "@" in text:
                at_pos = text.rfind("@")
                prefix = text[at_pos+1:]
                aids = ["alice", "bob", "evolclaw-ai", "my-agent", "tester"]
                for aid in aids:
                    if aid.startswith(prefix):
                        yield Completion(
                            f"{aid}.agentid.pub",
                            start_position=-len(prefix),
                            display=f"@{aid}",
                            display_meta="agentid.pub",
                        )

    session = PromptSession(
        completer=DemoCompleter(),
        style=DEMO_STYLE,
        complete_while_typing=True,
        bottom_toolbar=HTML(
            " <b>Auto-Completion Demo</b>  "
            "输入 <b>/</b> 看命令  |  "
            "输入 <b>@</b> 看联系人  |  "
            "输入 <b>done</b> 结束"
        ),
    )

    while True:
        try:
            text = session.prompt([("class:prompt", " ❯ ")], style=DEMO_STYLE)
            text = text.strip()
            if text == "done":
                break
            if text:
                result("输入", text)
        except (EOFError, KeyboardInterrupt):
            break


def demo_validation():
    banner("10. Validation — 输入验证")
    info("实时验证输入内容，不合法时无法提交\n")

    # AID 格式验证
    aid_validator = Validator.from_callable(
        lambda text: bool(text) and "." in text and len(text) >= 5,
        error_message="AID 格式不正确（需要 name.domain 格式，至少 5 个字符）",
        move_cursor_to_end=True,
    )

    session = PromptSession(
        style=DEMO_STYLE,
        bottom_toolbar=HTML(" <b>Validation Demo</b>  输入合法 AID (如 alice.agentid.pub)"),
    )

    try:
        text = session.prompt(
            [("class:prompt", " AID ❯ ")],
            validator=aid_validator,
            validate_while_typing=False,
            style=DEMO_STYLE,
        )
        result("合法 AID", text)
    except (EOFError, KeyboardInterrupt):
        info("已跳过")


def demo_bottom_toolbar():
    banner("11. Bottom Toolbar — 动态底栏")
    info("底栏实时更新，展示连接状态、计数器等")
    info("输入任意内容观察底栏变化，输入 done 结束\n")

    state = {"count": 0, "connected": True, "e2ee": True}

    def toolbar():
        state["count"] += 1  # 每次重绘 +1
        conn = "🟢 已连接" if state["connected"] else "🔴 未连接"
        enc = "🔒 E2EE" if state["e2ee"] else "🔓 明文"
        ts = datetime.now().strftime("%H:%M:%S")
        return HTML(
            f" <b>{conn}</b>  {enc}  "
            f"重绘: {state['count']}  "
            f"时间: {ts}"
        )

    session = PromptSession(
        style=DEMO_STYLE,
        bottom_toolbar=toolbar,
    )

    while True:
        try:
            text = session.prompt([("class:prompt", " ❯ ")], style=DEMO_STYLE)
            text = text.strip()
            if text == "done":
                break
            elif text == "disconnect":
                state["connected"] = False
                info("已模拟断开连接")
            elif text == "connect":
                state["connected"] = True
                info("已模拟重新连接")
            elif text == "plain":
                state["e2ee"] = not state["e2ee"]
                info(f"切换为 {'E2EE' if state['e2ee'] else '明文'}")
            elif text:
                info(f"输入: {text}")
        except (EOFError, KeyboardInterrupt):
            break


def demo_multiline():
    banner("12. Multiline Input — 多行输入")
    info("Ctrl+J 插入换行，Enter 提交")
    info("输入 done 结束\n")

    kb = KeyBindings()

    @kb.add("c-j")
    def _(event):
        event.current_buffer.insert_text("\n")

    session = PromptSession(
        style=DEMO_STYLE,
        key_bindings=kb,
        multiline=True,
        bottom_toolbar=HTML(
            " <b>Multiline Demo</b>  "
            "<b>Ctrl+J</b> 换行  |  "
            "<b>Enter</b> 提交  |  "
            "输入 <b>done</b> 结束"
        ),
    )

    while True:
        try:
            text = session.prompt([("class:prompt", " ❯ ")], style=DEMO_STYLE)
            text = text.strip()
            if text == "done":
                break
            if text:
                lines = text.split("\n")
                result("行数", len(lines))
                for i, line in enumerate(lines):
                    _p(f"  {C_DIM}L{i+1}:{C_RESET} {line}")
        except (EOFError, KeyboardInterrupt):
            break


# ══════════════════════════════════════════════════════════════════════════
# 4. 全屏应用 (Full-Screen Application)
# ══════════════════════════════════════════════════════════════════════════

def demo_fullscreen():
    banner("13. Full-Screen App — 全屏布局应用")
    info("展示 HSplit + VSplit + Window 组合布局")
    info("按 Ctrl+C 或 q 退出全屏\n")
    pause()

    kb = KeyBindings()

    @kb.add("c-c")
    @kb.add("q")
    def _(event):
        event.app.exit()

    # 左侧面板：会话列表
    sessions_text = (
        " Sessions\n"
        " ────────────────────\n"
        " ✓ evolclaw-ai  🟢\n"
        "   alice         🟢\n"
        "   bob           ⚫\n"
        "   tester-01     🟢\n"
        "   tester-02     ⚫\n"
        "\n"
        " ────────────────────\n"
        " 在线: 3 / 离线: 2\n"
    )

    # 右上：消息区域
    messages_text = (
        " Messages\n"
        " ──────────────────────────────────────\n"
        " 14:23:01 ◀ evolclaw-ai  你好！\n"
        " 14:23:05 ▶ alice        收到，正在处理\n"
        " 14:23:08 · evolclaw-ai  ACK seq=42\n"
        " 14:23:12 ▶ alice        处理完成，耗时7秒\n"
        " 14:24:01 ◀ bob          请帮我分析一下代码\n"
        " 14:24:02 ▶ bob          开始处理\n"
        " 14:25:30 ▶ bob          处理完成，耗时88秒\n"
    )

    # 右下：状态区域
    status_text = (
        " Status\n"
        " ──────────────────────────────────────\n"
        f" AID:    evolclaw-ai.agentid.pub\n"
        f" 网关:   wss://gateway.agentid.pub:20001\n"
        f" 加密:   🔒 E2EE\n"
        f" 消息:   1,247 条\n"
        f" 延迟:   12ms\n"
        f" 运行:   3h 42m\n"
    )

    fs_style = Style.from_dict({
        "left":        "bg:#16213e #c9d1d9",
        "right-top":   "bg:#0d1117 #c9d1d9",
        "right-bot":   "bg:#1a1a2e #c9d1d9",
        "separator":   "#e94560",
        "title-bar":   "bg:#e94560 #ffffff bold",
        "status-bar":  "bg:#1a1a2e #888888",
    })

    root = HSplit([
        # 标题栏
        Window(
            content=FormattedTextControl(
                " AUN CLI — Full-Screen Demo                          "
                "                    q / Ctrl+C = 退出"
            ),
            height=1,
            style="class:title-bar",
        ),
        # 主体
        VSplit([
            # 左侧
            Window(
                content=FormattedTextControl(sessions_text),
                width=24,
                style="class:left",
            ),
            # 分隔线
            Window(width=1, char="│", style="class:separator"),
            # 右侧
            HSplit([
                Window(
                    content=FormattedTextControl(messages_text),
                    style="class:right-top",
                ),
                Window(height=1, char="─", style="class:separator"),
                Window(
                    content=FormattedTextControl(status_text),
                    height=10,
                    style="class:right-bot",
                ),
            ]),
        ]),
        # 底栏
        Window(
            content=FormattedTextControl(
                f" 🟢 Connected  |  🔒 E2EE  |  "
                f"Sessions: 5  |  {datetime.now().strftime('%H:%M:%S')}"
            ),
            height=1,
            style="class:status-bar",
        ),
    ])

    app = Application(
        layout=Layout(root),
        full_screen=True,
        key_bindings=kb,
        style=fs_style,
    )
    app.run()


# ══════════════════════════════════════════════════════════════════════════
# 5. 富文本与格式化输出
# ══════════════════════════════════════════════════════════════════════════

def demo_formatted_text():
    banner("14. Formatted Text — 富文本输出")
    info("多种格式化方式：ANSI / HTML / FormattedText\n")

    # ANSI 转义码
    _p(f"  {C_BOLD}ANSI 转义码:{C_RESET}")
    _p(f"    {C_RED}红色{C_RESET}  {C_GREEN}绿色{C_RESET}  "
       f"{C_YELLOW}黄色{C_RESET}  {C_CYAN}青色{C_RESET}")
    _p(f"    {C_BOLD}粗体{C_RESET}  {C_DIM}暗淡{C_RESET}  "
       f"\033[4m下划线\033[24m  \033[7m反色\033[27m")
    _p(f"    \033[38;2;255;105;180m自定义 RGB (#FF69B4)\033[39m")
    _p(f"    {C_BG}自定义背景色{C_RESET}")
    print()

    # HTML 格式
    _p(f"  {C_BOLD}HTML 标记:{C_RESET}")
    print_formatted_text(HTML(
        '    <ansired>红色</ansired>  '
        '<ansigreen>绿色</ansigreen>  '
        '<ansiyellow>黄色</ansiyellow>  '
        '<ansicyan>青色</ansicyan>'
    ), color_depth=ColorDepth.TRUE_COLOR)
    print_formatted_text(HTML(
        '    <b>粗体</b>  <i>斜体</i>  <u>下划线</u>  '
        '<style bg="#e94560" fg="white"> 自定义样式 </style>'
    ), color_depth=ColorDepth.TRUE_COLOR)
    print()

    # FormattedText 元组
    _p(f"  {C_BOLD}FormattedText 元组:{C_RESET}")
    ft = FormattedText([
        ("#ff6b6b bold", "    错误: "),
        ("#e0e0e0",      "连接超时  "),
        ("#888888",      "(重试中…)\n"),
        ("#58a6ff bold", "    信息: "),
        ("#e0e0e0",      "已连接到网关  "),
        ("#238636",      "✓\n"),
    ])
    print_formatted_text(ft, color_depth=ColorDepth.TRUE_COLOR)


# ══════════════════════════════════════════════════════════════════════════
# 6. 全屏弹窗应用 (Widgets)
# ══════════════════════════════════════════════════════════════════════════

def demo_widget_dialog():
    banner("15. Widget Dialog — 自定义 Widget 弹窗")
    info("使用 TextArea, Button, RadioList 等 Widget 构建自定义弹窗")
    info("Tab 键切换焦点，Enter 确认\n")
    pause()

    result_holder = [None]

    text_area = TextArea(
        text="evolclaw-ai",
        multiline=False,
        style="bg:#16213e #e0e0e0",
    )

    radio = RadioList(values=[
        ("ws",   "WebSocket (推荐)"),
        ("http", "HTTP Long-Poll"),
        ("tcp",  "TCP Direct"),
    ])

    def ok_handler():
        result_holder[0] = {
            "aid": text_area.text,
            "mode": radio.current_value,
        }
        app.exit()

    def cancel_handler():
        app.exit()

    ok_btn = Button(text="确认", handler=ok_handler)
    cancel_btn = Button(text="取消", handler=cancel_handler)

    dialog = Dialog(
        title="连接配置",
        body=HSplit([
            Label(text="Agent ID:", style="#ff6b6b bold"),
            text_area,
            Label(text=""),
            Label(text="连接模式:", style="#ff6b6b bold"),
            radio,
        ], padding=0),
        buttons=[ok_btn, cancel_btn],
    )

    widget_style = Style.from_dict({
        "dialog":              "bg:#1a1a2e",
        "dialog frame.label":  "bg:#e94560 #ffffff bold",
        "dialog.body":         "bg:#16213e #e0e0e0",
        "dialog shadow":       "bg:#0a0a1a",
        "button":              "bg:#e94560 #ffffff",
        "button.focused":      "bg:#ff6b6b #ffffff bold",
        "text-area":           "bg:#0d1117 #e0e0e0",
        "radiolist":           "#e0e0e0",
        "radio":               "#e94560",
        "radio-checked":       "#ff6b6b bold",
    })

    app = Application(
        layout=Layout(
            HSplit([
                Window(),  # 占位，让 dialog 居中
            ]),
            dialog,
        ),
        full_screen=True,
        style=widget_style,
    )
    app.run()

    if result_holder[0]:
        result("AID", result_holder[0]["aid"])
        result("模式", result_holder[0]["mode"])
    else:
        info("已取消")


# ══════════════════════════════════════════════════════════════════════════
# 7. Async Prompt + patch_stdout
# ══════════════════════════════════════════════════════════════════════════

def demo_async_output():
    banner("16. Async Output — 异步输出 + patch_stdout")
    info("后台异步打印不会干扰输入行")
    info("输入任意内容，观察后台消息。输入 done 结束\n")

    async def _run():
        session = PromptSession(
            style=DEMO_STYLE,
            bottom_toolbar=HTML(
                " <b>Async Demo</b>  后台每 2 秒打印一条消息  |  输入 <b>done</b> 结束"
            ),
        )

        stop = asyncio.Event()

        async def background():
            names = ["evolclaw-ai", "alice", "bob", "tester"]
            msgs = ["你好！", "收到消息", "正在处理", "已完成", "有新任务"]
            i = 0
            while not stop.is_set():
                await asyncio.sleep(2)
                if stop.is_set():
                    break
                name = names[i % len(names)]
                msg = msgs[i % len(msgs)]
                ts = datetime.now().strftime("%H:%M:%S")
                _p(f"{C_DIM}{ts}{C_RESET} {C_GREEN}◀ {name}{C_RESET}  {msg}")
                i += 1

        with patch_stdout():
            task = asyncio.create_task(background())
            try:
                while True:
                    text = await session.prompt_async(
                        [("class:prompt", " ❯ ")],
                        style=DEMO_STYLE,
                    )
                    text = text.strip()
                    if text == "done":
                        break
                    if text:
                        _p(f"{C_DIM}{datetime.now().strftime('%H:%M:%S')}{C_RESET} "
                           f"{C_YELLOW}▶ me{C_RESET}  {C_DIM}{text}{C_RESET}")
            except (EOFError, KeyboardInterrupt):
                pass
            finally:
                stop.set()
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    asyncio.run(_run())


# ══════════════════════════════════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════════════════════════════════

DEMOS = [
    ("消息弹窗",        "message_dialog — 纯展示信息",          demo_message_dialog),
    ("确认弹窗",        "yes_no_dialog — 二元选择",             demo_yes_no_dialog),
    ("多按钮弹窗",      "button_dialog — 多选项按钮",           demo_button_dialog),
    ("输入弹窗",        "input_dialog — 文本/密码输入",         demo_input_dialog),
    ("单选弹窗",        "radiolist_dialog — 单选列表",          demo_radiolist_dialog),
    ("多选弹窗",        "checkboxlist_dialog — 多选列表",       demo_checkboxlist_dialog),
    ("自定义样式",      "Style + HTML — 完全自定义外观",         demo_styled_dialog),
    ("进度条",          "ProgressBar — 单任务/多任务",          demo_progress_bar),
    ("自动补全",        "Completer — 命令/联系人补全",          demo_completion),
    ("输入验证",        "Validator — 实时格式验证",              demo_validation),
    ("动态底栏",        "Bottom Toolbar — 状态实时更新",         demo_bottom_toolbar),
    ("多行输入",        "Multiline — Ctrl+J 换行",              demo_multiline),
    ("全屏应用",        "Full-Screen App — 多面板布局",          demo_fullscreen),
    ("富文本输出",      "Formatted Text — ANSI/HTML/元组",      demo_formatted_text),
    ("Widget 弹窗",    "Widget Dialog — 自定义组件弹窗",        demo_widget_dialog),
    ("异步输出",        "Async + patch_stdout — 后台消息",      demo_async_output),
]

def main():
    _p(f"\n{C_BG}{C_BOLD}{C_YELLOW}"
       f"  ╔══════════════════════════════════════════════════╗  {C_RESET}")
    _p(f"{C_BG}{C_BOLD}{C_YELLOW}"
       f"  ║     prompt_toolkit UI 功能全览 Demo              ║  {C_RESET}")
    _p(f"{C_BG}{C_BOLD}{C_YELLOW}"
       f"  ║     AUN CLI 使用的所有 UI 能力展示               ║  {C_RESET}")
    _p(f"{C_BG}{C_BOLD}{C_YELLOW}"
       f"  ╚══════════════════════════════════════════════════╝  {C_RESET}")
    _p("")

    # 选择运行模式
    mode = button_dialog(
        title="Demo 启动",
        text="选择运行方式：",
        buttons=[
            ("全部演示 (推荐)", "all"),
            ("选择演示", "pick"),
            ("退出", None),
        ],
        style=DEMO_STYLE,
    ).run()

    if mode is None:
        return

    if mode == "pick":
        selected = checkboxlist_dialog(
            title="选择要运行的 Demo",
            text="空格键选择，Tab 切换到按钮：",
            values=[(i, f"{name} — {desc}") for i, (name, desc, _) in enumerate(DEMOS)],
            default_values=list(range(len(DEMOS))),
            style=DEMO_STYLE,
        ).run()

        if not selected:
            return

        for idx in sorted(selected):
            name, desc, func = DEMOS[idx]
            try:
                func()
            except (EOFError, KeyboardInterrupt):
                pass
            if idx != sorted(selected)[-1]:
                pause()
    else:
        for i, (name, desc, func) in enumerate(DEMOS):
            try:
                func()
            except (EOFError, KeyboardInterrupt):
                pass
            if i < len(DEMOS) - 1:
                pause()

    banner("Demo 结束")
    _p(f"  {C_GREEN}所有 prompt_toolkit 功能演示完毕！{C_RESET}")
    _p(f"  {C_DIM}这些功能均可在 AUN CLI 中使用{C_RESET}\n")


if __name__ == "__main__":
    main()
