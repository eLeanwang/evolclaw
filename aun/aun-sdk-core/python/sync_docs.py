#!/usr/bin/env python3
"""
sync_docs.py — 将 skill 文档和 AUN 协议文档同步到 SDK 包内。

源目录：
  1. skill 文档:  D:/modelunion/aun-skill/.claude/skills/aun-sdk/
  2. AUN 协议:    D:/modelunion/kite/docs/AUN文档/AUN协议/

目标目录：
  D:/modelunion/kite/aun-sdk-core/python/src/aun_core/docs/
    ├── skill/          ← skill 文档（methods, sdk-core, rpc-manual, examples 等）
    └── protocol/       ← AUN 协议规范

用法：
  python sync_docs.py              # 正常同步
  python sync_docs.py --dry-run    # 仅预览，不实际操作
  python sync_docs.py --clean      # 同步前先清空目标目录
"""
import argparse
import shutil
from pathlib import Path

# ── 路径配置 ──────────────────────────────────────────────

SKILL_SRC = Path(r"D:/modelunion/aun-skill/.claude/skills/aun-sdk")
PROTOCOL_SRC = Path(r"D:/modelunion/kite/docs/AUN文档/AUN协议")

SDK_DOCS = Path(__file__).resolve().parent / "src" / "aun_core" / "docs"

# skill 目录下要同步的子目录/文件（排除 SKILL.md 本身）
SKILL_ITEMS = [
    "methods",
    "sdk-core",
    "rpc-manual",
    "examples",
    "docs",
    "checklists",
    "references",
    "总体架构.md",
]


# ── 同步逻辑 ──────────────────────────────────────────────

def sync_item(src: Path, dst: Path, *, dry_run: bool = False) -> int:
    """复制单个文件或目录，返回复制的文件数。"""
    count = 0
    if src.is_file():
        if dry_run:
            print(f"  COPY {src} -> {dst}")
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        count = 1
    elif src.is_dir():
        for item in sorted(src.rglob("*")):
            if item.is_file():
                rel = item.relative_to(src)
                target = dst / rel
                if dry_run:
                    print(f"  COPY {item} -> {target}")
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(item, target)
                count += 1
    else:
        print(f"  SKIP {src} (not found)")
    return count


def main():
    parser = argparse.ArgumentParser(description="同步文档到 SDK 包内")
    parser.add_argument("--dry-run", action="store_true", help="仅预览，不实际复制")
    parser.add_argument("--clean", action="store_true", help="同步前先清空目标 docs 目录")
    args = parser.parse_args()

    # 前置检查
    for label, path in [("Skill", SKILL_SRC), ("Protocol", PROTOCOL_SRC)]:
        if not path.exists():
            print(f"ERROR: {label} 源目录不存在: {path}")
            return 1

    # 清理
    if args.clean and SDK_DOCS.exists():
        if args.dry_run:
            print(f"[dry-run] CLEAN {SDK_DOCS}")
        else:
            shutil.rmtree(SDK_DOCS)
            print(f"CLEANED {SDK_DOCS}")

    total = 0

    # 1) 同步 skill 文档
    skill_dst = SDK_DOCS / "skill"
    print(f"\n=== Skill 文档 ===")
    print(f"  FROM: {SKILL_SRC}")
    print(f"  TO:   {skill_dst}\n")
    for name in SKILL_ITEMS:
        src = SKILL_SRC / name
        dst = skill_dst / name
        n = sync_item(src, dst, dry_run=args.dry_run)
        total += n

    # 2) 同步 AUN 协议文档
    protocol_dst = SDK_DOCS / "protocol"
    print(f"\n=== AUN 协议文档 ===")
    print(f"  FROM: {PROTOCOL_SRC}")
    print(f"  TO:   {protocol_dst}\n")
    total += sync_item(PROTOCOL_SRC, protocol_dst, dry_run=args.dry_run)

    prefix = "[dry-run] " if args.dry_run else ""
    print(f"\n{prefix}Done. {total} files synced to {SDK_DOCS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
