---
name: webnovel-writer
description: 持续创作和维护多部长篇网络小说；用于选择活动作品、按章节范围匹配篇纲、生成轻量写作任务书、写作与审查章节、应用结构化记忆补丁、查询长期记忆和生成篇末摘要。
---

# Webnovel Writer

把 Markdown 作为事实源，通过可重建索引按需读取资料。不要把整部小说、大纲或记忆库一次性装入上下文。

## 核心规则

- 先读取 `小说项目/projects.json`，只操作 `小说项目/作品/<activeProjectId>/`。
- 找不到活动作品时停止，不跨小说补资料。
- 根据篇纲中的 `章节范围` 匹配 `大纲/第NN篇_*.md`；不要寻找固定的 `第一卷.md`。
- 写正文前必须存在已确认的 `大纲/细纲_第XXX章.md`；脚本不得虚构细纲。
- 写章前读取 `记忆库/current/本章写作任务书.md`、任务书列出的连续前五章正文全文，以及任务书明确要求回查的来源；不足五章时读取已有全部前章。
- 正文保持 2000—2500 字；用户没有明确要求写第几章时不要生成正文。
- Markdown 记忆是事实源，`memory_index.json` 只是可删除重建的索引。
- 不读取旧版正文、旧版设定备份或 `.trash` 作为当前事实。

## 按需参考

- 处理长期记忆时读取 `references/长篇记忆机制.md`。
- 生成或应用补丁时读取 `references/记忆补丁格式.md` 和 `references/current投影规则.md`。
- 生成章节提交时读取 `references/章节提交规范.md`。
- 把控文风时读取 `references/写作风格规则.md`。
- 审查章节时读取 `references/章节审查规范.md`。

## 写章前

1. 运行 `scripts/memory_doctor.py --chapter XXX`，先处理 error；存在 workflow blocker 时停止写作。
2. 确认本章细纲已经按当前篇纲完成并通过用户要求的检查。
3. 运行 `scripts/build_context.py --chapter XXX --budget-chars 1500`。
4. 读取生成的 `本章写作任务书.md`。
5. 全文读取任务书“前置正文（必须全文读取）”列出的每个当前正文文件；必须以磁盘上最新保存的正文为准，不得用旧摘要或旧版备份代替。缺少任一连续前章时停止写作。
6. 只有任务书列出其他来源 ID 或遇到明确事实疑问时，才运行 `query_memory.py` 或回查对应档案。

前五章正文用于理解最新原文、衔接、语气和细节；任务书中的结构化摘要与 current 用于确认长期状态。两者必须同时使用，正文与摘要冲突时先报告并以用户最新修改的正文为准，不得静默沿用旧摘要。不要加载五章以前的正文或长篇大纲全文，除非存在明确事实疑问。

## 写作与审查

1. 按任务书写正文，不把“细纲、伏笔、读者、本章”等工程词写进正文。
2. 运行 `scripts/check_chapter.py` 检查章节号、字数和确定性问题。
3. 按 `references/章节审查规范.md` 输出审查报告；先修复 S1、S2，再保存最终正文。
4. 将正文保存为 `正文/第XXX章_标题.md`，审查报告保存到 `审查报告/`。

## 写章后

1. 在 `章节提交/` 保存章节提交记录。
2. 按 `references/记忆补丁格式.md` 生成结构化 memory_patch；只写会影响后续的变化。
3. 先运行 `scripts/update_memory.py --patch <补丁文件> --dry-run`。
4. dry-run 无错误后，运行同一命令但去掉 `--dry-run`。脚本负责合并 current、归档失效条目、记录补丁和重建索引。
5. 重复执行相同 `patch_id` 必须得到幂等跳过；不要手工复制补丁内容到 current。

## 查询和篇末压缩

- 使用 `scripts/query_memory.py --chapter XXX --entity 人物 --tag 标签 --limit 20` 查询相关记忆。
- 只在完整篇章结束时运行 `scripts/compact_memory.py --range 001-030 --dry-run`，确认后去掉 `--dry-run`。
- 非篇末范围只允许诊断，不生成 snapshot。
- 每章摘要和章末状态保存在 memory_patch；snapshot 只保存篇末总结。

## 旧项目迁移

首次升级旧项目时，先运行：

```text
scripts/memory_doctor.py --chapter XXX --migrate-legacy --rebuild-index --dry-run
```

确认范围后去掉 `--dry-run`。迁移只补充单行元数据，不改写原有事实；旧 `本章上下文包.md` 移入 `.trash` 并改用 `本章写作任务书.md`。
