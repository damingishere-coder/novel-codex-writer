#!/usr/bin/env python3
"""Query the rebuildable memory index without loading the whole novel."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from memory_common import (
    MemorySystemError,
    ensure_index,
    load_indexed_records,
    normalize_chapter,
    rank_index_records,
    resolve_library_root,
    resolve_project_root,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="按章节、人物和标签查询当前小说的结构化记忆。")
    parser.add_argument("--chapter", required=True, help="目标章节号，例如 1 或 001。")
    parser.add_argument("--entity", action="append", default=[], help="相关人物或实体；可以重复传入。")
    parser.add_argument("--tag", action="append", default=[], help="相关标签；可以重复传入。")
    parser.add_argument("--text", default="", help="用于匹配记忆标签的细纲文本。")
    parser.add_argument("--limit", type=int, default=20, help="最多返回多少条普通记忆，默认 20。")
    parser.add_argument("--library-root", default="小说项目", help="作品库目录。")
    parser.add_argument("--project-root", default=None, help="小说目录；默认读取 activeProjectId。")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果。")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        chapter, _ = normalize_chapter(args.chapter)
        if args.limit <= 0:
            raise MemorySystemError("--limit 必须大于 0。")
        library_root = resolve_library_root(args.library_root)
        project_root = resolve_project_root(library_root, args.project_root)
        index = ensure_index(project_root)
        selected_items, omitted_items = rank_index_records(
            index,
            chapter,
            entities=args.entity,
            tags=args.tag,
            query_text=args.text,
            limit=args.limit,
        )
        records = load_indexed_records(project_root, selected_items)
    except MemorySystemError as exc:
        print(f"错误：{exc}")
        return 2

    results = []
    for record in records:
        results.append(
            {
                "id": record.record_id,
                "category": record.metadata.get("category"),
                "status": record.metadata.get("status"),
                "importance": record.metadata.get("importance"),
                "entities": record.metadata.get("entities", []),
                "tags": record.metadata.get("tags", []),
                "content": record.content,
                "source": record.path.relative_to(project_root).as_posix(),
                "line": record.line,
            }
        )

    if args.json:
        print(
            json.dumps(
                {
                    "chapter": chapter,
                    "count": len(results),
                    "records": results,
                    "omitted_ids": [item["id"] for item in omitted_items],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    print(f"第{chapter:03d}章记忆查询：命中 {len(results)} 条")
    for item in results:
        print(f"\n[{item['importance']}/{item['category']}] {item['id']}")
        print(item["content"])
        print(f"来源：{item['source']}:{item['line']}")
    if omitted_items:
        print("\n未展开来源 ID：" + "、".join(str(item["id"]) for item in omitted_items))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

