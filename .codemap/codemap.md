<!--
  This file:        .codemap/codemap.md   (written report)
  Interactive map:  .codemap/codemap.html
-->

# webnovel-writer Skill — Functional Module Quality Audit

> **Interactive view:** [`.codemap/codemap.html`](codemap.html) — per-module scores, findings, LoC, and the dependency graph. This file is the written report.

**Generated:** 2026-08-25 · **Modules:** 15 · **Size:** 17550 tracked LoC across 97 files

## Health by layer

| Layer | Modules | Avg score |
|---|--:|--:|
| 前端 · 写作工作台 | 4 | 99 |
| 服务端 · 本地 API | 5 | 97 |
| 写作引擎 · Skill 与 Python | 5 | 96 |
| 交付 · 运行与治理 | 1 | 100 |

## Per-module lines of code & score

_LoC is the representative file/folder per module; folder-level modules overlap and are not additive._

### 前端 · 写作工作台

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Workbench Components | 2,285 | 98 A | bloat |
| Workbench App Shell | 1,907 | 100 A | — |
| Client API & Utilities | 1,394 | 100 A | — |
| Shared Contracts | 369 | 98 A | duplication |

### 服务端 · 本地 API

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Local API Gateway | 2,462 | 98 A | bloat |
| Chapter Review Pipeline | 1,341 | 95 A | bloat, god-component |
| File Storage & Recovery | 1,151 | 98 A | bloat |
| Workflow Orchestration | 777 | 95 A | bloat, god-component |
| Server Guards & Utilities | 457 | 100 A | — |

### 写作引擎 · Skill 与 Python

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Memory Core | 2,524 | 95 A | bloat |
| Context Retrieval | 770 | 93 A | bloat, legacy |
| Memory Operations | 654 | 98 A | legacy |
| Chapter Checker | 487 | 96 A | duplication, bloat |
| Writing Skill Specification | 353 | 100 A | — |

### 交付 · 运行与治理

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Runtime & Delivery | 619 | 100 A | — |

## Worst offenders

- **Context Retrieval (93/A)** — Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/build_context.py:1: 单文件 653 行、25 个定义，同时承担 Markdown 解析、篇纲/细纲门禁、连续前章选择、索引检索、预算裁剪、任务书渲染、revision 元数据、事务写入和 CLI 编排；职责集中使规则变更与回归维护成本偏高。
- **Workflow Orchestration (95/A)** — Novel-Codex-Writer/frontend/server/workflow-api.ts:441: 约 772 行模块仍集中承担状态表计算、artifact/revision 校验、proof/context 重读、patch 分类与选择、Python 解释器和进程树生命周期、动作编排，职责边界过宽，维护性风险仍在。
- **Chapter Review Pipeline (95/A)** — Novel-Codex-Writer/frontend/server/chapter-review.ts:358: 约 890 行模块仍集中承担上下文读取、确定性检查、AI schema 解析、事实核查、revision manifest 与运行记录规范化，职责边界过宽，维护性风险仍在。
- **Memory Core (95/A)** — Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/memory_transactions.py:190: 继承/普通锁续租与 lost event、staging/每次替换/恢复/回滚前 owner 复检已覆盖先前并发风险；当前主要维护风险仍是 788 行模块集中实现锁回收、事务 staging、提交、回滚和恢复，且 memory_patch_schema.py 仍约 760 行并混合记录、patch、ledger、proof、manifest 与历史选择职责，后续协议改动回归面较大。
- **Chapter Checker (96/A)** — Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/check_chapter.py:152: strip_markdown/count_readable_words、重复段落和标点检查仍与TypeScript入口分别实现；共享规则JSON以及tests/test_chapter_checker_smoke.py:53-68和TS fixture测试已显著降低漂移风险，但算法修改仍需双边维护。
- **Workbench Components (98/A)** — Novel-Codex-Writer/frontend/src/components/WorkbenchView.tsx:159: WorkbenchView 当前 609 行，同时包含主工作台、PaneResizeHandle、多个项目/设置/文档对话框、Modal 及状态页，多个交互边界集中在单文件，维护负担偏高。
- **Shared Contracts (98/A)** — Novel-Codex-Writer/frontend/src/types.ts:152: ReviewFinding、ReviewContextManifestItem、ChapterReviewRun在客户端types.ts:152-194与服务端chapter-review.ts:11-76分别维护，字段和枚举当前一致但没有共享类型约束；api.ts还另有一套运行时校验，后续字段或枚举变更存在前后端漂移风险。
- **Local API Gateway (98/A)** — Novel-Codex-Writer/frontend/server/novel-library-plugin.ts:332: 网关文件仍约 1612 行，集中注册并编排 projects、library、document、versions、trash、export、workflow、search、metrics、AI、review 等多类路由；服务虽已拆分，仍有明显职责与维护体量。
- **File Storage & Recovery (98/A)** — Novel-Codex-Writer/frontend/server/file-storage.ts:1: file-storage.ts 当前约 843 行，同时承载路径安全、锁、文档读写、历史、回收站和 Markdown/ZIP 导出，职责面过宽，维护成本较高。
- **Memory Operations (98/A)** — Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/compact_memory.py:171: 篇末压缩仍调用兼容选择器，旧 schema v1 或单个 legacy_unknown patch 可在没有新鲜 v2 finalization manifest 时进入 snapshot；这是明确的兼容路径，但与当前 v2 fail-closed 门禁并行，仍是待淘汰的 legacy surface。

## All findings

### MED (4)

- **Workflow Orchestration** · `Novel-Codex-Writer/frontend/server/workflow-api.ts:441` — 约 772 行模块仍集中承担状态表计算、artifact/revision 校验、proof/context 重读、patch 分类与选择、Python 解释器和进程树生命周期、动作编排，职责边界过宽，维护性风险仍在。
- **Chapter Review Pipeline** · `Novel-Codex-Writer/frontend/server/chapter-review.ts:358` — 约 890 行模块仍集中承担上下文读取、确定性检查、AI schema 解析、事实核查、revision manifest 与运行记录规范化，职责边界过宽，维护性风险仍在。
- **Memory Core** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/memory_transactions.py:190` — 继承/普通锁续租与 lost event、staging/每次替换/恢复/回滚前 owner 复检已覆盖先前并发风险；当前主要维护风险仍是 788 行模块集中实现锁回收、事务 staging、提交、回滚和恢复，且 memory_patch_schema.py 仍约 760 行并混合记录、patch、ledger、proof、manifest 与历史选择职责，后续协议改动回归面较大。
- **Context Retrieval** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/build_context.py:1` — 单文件 653 行、25 个定义，同时承担 Markdown 解析、篇纲/细纲门禁、连续前章选择、索引检索、预算裁剪、任务书渲染、revision 元数据、事务写入和 CLI 编排；职责集中使规则变更与回归维护成本偏高。

### LOW (8)

- **Workbench Components** · `Novel-Codex-Writer/frontend/src/components/WorkbenchView.tsx:159` — WorkbenchView 当前 609 行，同时包含主工作台、PaneResizeHandle、多个项目/设置/文档对话框、Modal 及状态页，多个交互边界集中在单文件，维护负担偏高。
- **Shared Contracts** · `Novel-Codex-Writer/frontend/src/types.ts:152` — ReviewFinding、ReviewContextManifestItem、ChapterReviewRun在客户端types.ts:152-194与服务端chapter-review.ts:11-76分别维护，字段和枚举当前一致但没有共享类型约束；api.ts还另有一套运行时校验，后续字段或枚举变更存在前后端漂移风险。
- **Local API Gateway** · `Novel-Codex-Writer/frontend/server/novel-library-plugin.ts:332` — 网关文件仍约 1612 行，集中注册并编排 projects、library、document、versions、trash、export、workflow、search、metrics、AI、review 等多类路由；服务虽已拆分，仍有明显职责与维护体量。
- **File Storage & Recovery** · `Novel-Codex-Writer/frontend/server/file-storage.ts:1` — file-storage.ts 当前约 843 行，同时承载路径安全、锁、文档读写、历史、回收站和 Markdown/ZIP 导出，职责面过宽，维护成本较高。
- **Memory Operations** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/compact_memory.py:171` — 篇末压缩仍调用兼容选择器，旧 schema v1 或单个 legacy_unknown patch 可在没有新鲜 v2 finalization manifest 时进入 snapshot；这是明确的兼容路径，但与当前 v2 fail-closed 门禁并行，仍是待淘汰的 legacy surface。
- **Context Retrieval** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/build_context.py:119` — 仍保留 --max-section-chars 旧参数并映射到任务书总预算；当前有明确互斥校验和迁移提示，属于有界但仍在运行的 legacy 兼容面。
- **Chapter Checker** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/check_chapter.py:152` — strip_markdown/count_readable_words、重复段落和标点检查仍与TypeScript入口分别实现；共享规则JSON以及tests/test_chapter_checker_smoke.py:53-68和TS fixture测试已显著降低漂移风险，但算法修改仍需双边维护。
- **Chapter Checker** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/check_chapter.py:1` — 当前约487行，仍集中承担规则加载、CLI、路径与链接校验、Markdown计数、章节号解析、多类检查、报告渲染、锁和写入；职责相关但维护面偏大。

## Cross-cutting themes

- **并发写入已经变为显式冲突.** 正文、历史、作品索引和 Python 记忆事务使用跨进程锁、revision/hash 重检、锁所有权续租与原子替换；竞争者不再静默覆盖，而是提交成功、幂等跳过或返回明确冲突。
- **Canonical 路径边界覆盖递归入口.** 显式文件、作品库扫描、审阅上下文、历史、回收站、导出、工作流与 Python memory 工具都验证真实路径；项目外 junction/symlink 哨兵会在入口被拒绝。
- **AI 与最终化协议改为 fail-closed.** 客户端响应、AI finding、stored run、review proof、patch、finalization manifest 与 context revisions 均做运行时校验；损坏、陈旧或缺少服务端签发依据的状态不能降级为通过。
- **核心 seam 已提取，剩余 bloat 被显式记录.** 项目、文档、Provider、会话、错误、可观测性、App hooks 与 Memory Core 均完成分段；Workflow、Storage、Chapter Review 和 Gateway 仍偏大，但已降为有测试覆盖的维护性债务。
- **CI、覆盖率与关键 E2E 已成为真实门禁.** CI 运行两组 Python 测试与覆盖率、135 个 Vitest、TypeScript/Vite 构建、依赖审计和 3 条关键 Playwright 流程；本机 Sonar 使用相同 LCOV/XML 产物做独立扫描。
- **预算、缓存与取消约束大型作品成本.** 扫描文件/字节、上下文、工作流读取、Provider 输出/耗时、导出与 verification bundle 都有硬上限；请求缓存、幂等合并及进程树终止降低重复 I/O、挂起与重复计费。

