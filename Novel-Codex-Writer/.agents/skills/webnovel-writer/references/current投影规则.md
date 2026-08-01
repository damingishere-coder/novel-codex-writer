# current 投影规则

current 保存“下一章仍可能生效的状态”，不是完整历史。

## 条目状态

- `active`：已经成立并仍然有效。
- `tentative`：计划、推测或尚待正文确认。
- `closed`：伏笔、任务或临时状态已经结束。
- `outdated`：被后续事实替换。
- `contradicted`：与更可靠来源冲突，保留供审计但不得继续使用。

只有 `active` 和 `tentative` 可以留在 current。其余状态由脚本迁入档案库。

## 更新规则

- 每个可更新事实使用稳定 ID；更新同一事实时执行 `upsert`，不要创建近义重复条目。
- 使用 `close` 结束伏笔或任务，使用 `archive` 替换失效状态。
- 先执行 `update_memory.py --dry-run`，全部操作合法后再正式写入。
- 脚本只修改带 `webnovel-memory` 元数据的条目；手工段落不得被静默删除。
- 同一 `patch_id` 重复执行时幂等跳过；相同 ID 但内容不同必须报错。

## 索引规则

`记忆库/index/memory_index.json` 不是事实源。它只保存检索字段、Markdown 位置、章节摘要和已应用补丁 ID；缺失或过期时从 current、档案和章节补丁重建。

