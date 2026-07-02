"""
每 60 秒随机选一个本机 AID 向目标发送一条消息，轮询所有支持的消息类型：
text → image → video → voice → file → link → custom payload

用法: python test_msg_send.py
按任意键退出（Windows）。
"""

import json
import msvcrt
import random
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


TARGET_AIDS = [
    "wang.agentid.pub",
    "elean.agentid.pub",
    "evolapp.agentid.pub",
    "toleiliang.agentid.pub",
    "bradtest.agentid.pub",
]
SAMPLES_DIR = Path(__file__).parent / "test_samples"
INTERVAL_SEC = 15


def run(cmd, capture=False):
    print(f"$ {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if not capture:
        out = result.stdout.strip() or result.stderr.strip()
        if out:
            print(out)
        print()
    return result


def fetch_aids_once():
    print("Fetching available AIDs...")
    result = run("ec agent list --format json", capture=True)
    if result.returncode != 0:
        print(result.stderr.strip() or "ec agent list failed")
        return []
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        print(f"Failed to parse agent list: {e}")
        return []

    agents = data.get("agents", [])
    available = [a for a in agents if a.get("status") != "disabled"]

    print(f"\nFound {len(agents)} agent(s), {len(available)} available (excluding disabled):")
    for a in agents:
        marker = "*" if a.get("status") != "disabled" else " "
        name = a.get("name") or ""
        status = a.get("status") or "?"
        channels = ",".join(a.get("channels") or []) or "-"
        print(f"  {marker} {a['aid']:<35} [{status:<8}] {name}  ({channels})")
    print()

    return [a["aid"] for a in available]


def ensure_samples():
    SAMPLES_DIR.mkdir(exist_ok=True)
    # 仅自动创建 voice / file 两个轻量样本；image/video 由用户提供。
    auto = {
        "sample.mp3": b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 256,
        "sample.txt": b"hello from evolclaw test_msg_send.py\n",
    }
    for name, data in auto.items():
        path = SAMPLES_DIR / name
        if not path.exists():
            path.write_bytes(data)

    samples = {
        "image": SAMPLES_DIR / "test.jpg",
        "video": SAMPLES_DIR / "test.mp4",
        "voice": SAMPLES_DIR / "sample.mp3",
        "file":  SAMPLES_DIR / "sample.txt",
    }
    missing = [str(p) for p in (samples["image"], samples["video"]) if not p.exists()]
    if missing:
        print("[ERROR] Missing required sample files:")
        for p in missing:
            print(f"  - {p}")
        sys.exit(1)
    return samples


def build_commands(from_aid, to_aid, samples):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    base = f"ec msg send {from_aid} {to_aid}"
    payload = f'{{\\"type\\":\\"custom\\",\\"note\\":\\"hi from {from_aid} at {now}\\"}}'
    return [
        ("text",   f'{base} "Hi! Greetings from {from_aid}, current time is {now}"'),
        ("image",  f'{base} --file "{samples["image"]}" --as image --text "image @ {now}"'),
        ("video",  f'{base} --file "{samples["video"]}" --as video --text "video @ {now}"'),
        ("voice",  f'{base} --file "{samples["voice"]}" --as voice --transcript "voice transcript @ {now}"'),
        ("file",   f'{base} --file "{samples["file"]}" --as file'),
        ("link",   f'{base} --link https://agentunion.cn --title "AgentUnion" --description "test link @ {now}"'),
        ("custom", f'{base} --payload "{payload}"'),
    ]


def sleep_until_keypress(seconds):
    """等待 seconds 秒；期间任何键按下立即返回 True，超时返回 False。"""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if msvcrt.kbhit():
            msvcrt.getch()
            return True
        time.sleep(0.1)
    return False


def main():
    samples = ensure_samples()
    aids = fetch_aids_once()
    if not aids:
        print("No running agents available. Exit.")
        sys.exit(1)

    from_aid = random.choice(aids)
    print(f"Sender:   {from_aid}  (chosen randomly, fixed for this run)")
    print(f"Targets:  {', '.join(TARGET_AIDS)}")
    print(f"Samples:  {SAMPLES_DIR}")
    print(f"Interval: {INTERVAL_SEC}s. Press any key to quit.\n")

    idx = 0
    while True:
        kind_idx = idx % 7
        kind = build_commands(from_aid, TARGET_AIDS[0], samples)[kind_idx][0]
        print(f"--- [{idx + 1}] type={kind} from={from_aid} ---")
        for to_aid in TARGET_AIDS:
            _, cmd = build_commands(from_aid, to_aid, samples)[kind_idx]
            print(f"  -> {to_aid}")
            run(cmd)
        idx += 1
        if sleep_until_keypress(INTERVAL_SEC):
            print("\nKey pressed. Bye.")
            return


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nBye.")
        sys.exit(0)