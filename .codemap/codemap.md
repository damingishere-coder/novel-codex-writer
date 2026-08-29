<!--
  This file:        .codemap/codemap.md   (written report)
  Interactive map:  .codemap/codemap.html
-->

# webnovel-writer Skill — Functional Module Quality Audit

> **Interactive view:** [`.codemap/codemap.html`](codemap.html) — per-module scores, findings, LoC, and the dependency graph. This file is the written report.

**Generated:** 2026-08-30 · **Modules:** 15 · **Size:** 19336 tracked LoC across 111 files

## Health by layer

| Layer | Modules | Avg score |
|---|--:|--:|
| 前端 · 写作工作台 | 4 | 78 |
| 服务端 · 本地 API | 5 | 79 |
| 写作引擎 · Skill 与 Python | 5 | 96 |
| 交付 · 运行与治理 | 1 | 79 |

## Per-module lines of code & score

_LoC is the representative file/folder per module; folder-level modules overlap and are not additive._

### 前端 · 写作工作台

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Workbench Components | 2,719 | 88 B | bloat |
| Workbench App Shell | 1,979 | 58 D | bloat, god-component |
| Client API & Utilities | 1,527 | 84 B | over-fit |
| Shared Contracts | 497 | 84 B | over-fit, duplication |

### 服务端 · 本地 API

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Local API Gateway | 3,109 | 58 D | bloat |
| Chapter Review Pipeline | 1,341 | 95 A | bloat, god-component |
| File Storage & Recovery | 1,151 | 98 A | bloat |
| Workflow Orchestration | 900 | 48 D | duplication, bloat, god-component, legacy |
| Server Guards & Utilities | 494 | 98 A | — |

### 写作引擎 · Skill 与 Python

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Memory Core | 2,524 | 95 A | bloat |
| Context Retrieval | 770 | 93 A | bloat, legacy |
| Memory Operations | 655 | 98 A | — |
| Chapter Checker | 487 | 96 A | duplication, bloat |
| Writing Skill Specification | 353 | 100 A | — |

### 交付 · 运行与治理

| Module | LoC | Score | Tags |
|---|--:|:--|:--|
| Runtime & Delivery | 830 | 79 B | fallback, over-fit |

## Worst offenders

- **Workflow Orchestration (48/D)** — Novel-Codex-Writer/frontend/server/workflow-api.ts:135: 任务书门禁只验证 chapter、taskbook_revision 和 sources 为数组，允许 sources=[] 且 status=ready 的非空任务书直接 ready，也未校验 metadata schema 或必需来源；后续最终化只把任务书本体当 source revision，不重新验证任务书 metadata，违反 fail-closed 目标。
- **Workbench App Shell (58/D)** — Novel-Codex-Writer/frontend/src/hooks/useWorkflowController.ts:108: 工作流动作完成后由请求启动时捕获的异步闭包调用 onOpenPath；请求期间只校验 project/chapter workflowKey，没有校验当前 draft revision 或 dirty 状态。用户启动长动作后继续编辑时，旧闭包仍可能认为 dirty=false，自动切换到产物并覆盖未保存草稿现场。
- **Local API Gateway (58/D)** — Novel-Codex-Writer/frontend/server/project-import.ts:257: 导入确认在读取 staged token、ZIP 并完成 importProject 副作用后才删除 token；两个并发确认或网络超时后的重试可同时消费同一 token，并由 project-service 依次创建两个不同项目副本。现有测试只覆盖串行二次使用。
- **Runtime & Delivery (79/B)** — Novel-Codex-Writer/frontend/server/system-preflight.ts:27: Python 预检只按 PATH 调用 py/python；实际工作流优先使用 NOVEL_PYTHON_BIN、VIRTUAL_ENV 或固定绝对路径。无效配置或 PATH 差异会让预检显示通过，但实际动作返回 PYTHON_NOT_CONFIGURED。
- **Client API & Utilities (84/B)** — Novel-Codex-Writer/frontend/src/lib/format.ts:40: getLineText 与 replaceLineRange 会把超出当前正文范围的行号静默裁剪到最后一行，而不是拒绝失效区间。调用方在比较裁剪后的文本后执行替换；若旧批注行号已越界且 before 恰好等于当前末行，作者确认后可能把建议写到错误的最后一行。现有测试仅覆盖有效行号。
- **Shared Contracts (84/B)** — Novel-Codex-Writer/frontend/shared/review-anchor.ts:1: 行号超出正文范围时会静默裁剪到最后一行；同样裁剪逻辑也存在于 frontend/src/lib/format.ts。上层采用建议时可能把失效批注应用到错误行，契约层没有明确的越界拒绝语义。
- **Workbench Components (88/B)** — Novel-Codex-Writer/frontend/src/components/WorkbenchView.tsx:66: WorkbenchView.tsx 已达 729 行；模型定义约 50 个状态字段和约 39 个动作，同时编排主工作台、侧栏、编辑器、预览、右栏、项目 CRUD、ZIP 导入、预检、AI 设置和多种弹窗。当前行为未见错误，但变更影响面和耦合度已实质偏高。
- **Context Retrieval (93/A)** — Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/build_context.py:1: 单文件 653 行、25 个定义，同时承担 Markdown 解析、篇纲/细纲门禁、连续前章选择、索引检索、预算裁剪、任务书渲染、revision 元数据、事务写入和 CLI 编排；职责集中使规则变更与回归维护成本偏高。
- **Chapter Review Pipeline (95/A)** — Novel-Codex-Writer/frontend/server/chapter-review.ts:358: 约 890 行模块仍集中承担上下文读取、确定性检查、AI schema 解析、事实核查、revision manifest 与运行记录规范化，职责边界过宽，维护性风险仍在。
- **Memory Core (95/A)** — Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/memory_transactions.py:190: 继承/普通锁续租与 lost event、staging/每次替换/恢复/回滚前 owner 复检已覆盖先前并发风险；当前主要维护风险仍是 788 行模块集中实现锁回收、事务 staging、提交、回滚和恢复，且 memory_patch_schema.py 仍约 760 行并混合记录、patch、ledger、proof、manifest 与历史选择职责，后续协议改动回归面较大。

## All findings

### HIGH (3)

- **Workbench App Shell** · `Novel-Codex-Writer/frontend/src/hooks/useWorkflowController.ts:108` — 工作流动作完成后由请求启动时捕获的异步闭包调用 onOpenPath；请求期间只校验 project/chapter workflowKey，没有校验当前 draft revision 或 dirty 状态。用户启动长动作后继续编辑时，旧闭包仍可能认为 dirty=false，自动切换到产物并覆盖未保存草稿现场。
- **Local API Gateway** · `Novel-Codex-Writer/frontend/server/project-import.ts:257` — 导入确认在读取 staged token、ZIP 并完成 importProject 副作用后才删除 token；两个并发确认或网络超时后的重试可同时消费同一 token，并由 project-service 依次创建两个不同项目副本。现有测试只覆盖串行二次使用。
- **Workflow Orchestration** · `Novel-Codex-Writer/frontend/server/workflow-api.ts:135` — 任务书门禁只验证 chapter、taskbook_revision 和 sources 为数组，允许 sources=[] 且 status=ready 的非空任务书直接 ready，也未校验 metadata schema 或必需来源；后续最终化只把任务书本体当 source revision，不重新验证任务书 metadata，违反 fail-closed 目标。

### MED (15)

- **Workbench App Shell** · `Novel-Codex-Writer/frontend/src/App.tsx:78` — App 仍集中维护约 600 行全局状态、异步初始化、文档/项目导航、保存恢复、导入、AI 设置、工作流和大量 action wiring；此前虽已提取 hooks，但根组件仍承担过宽的可变状态边界，上述 stale-closure 是其具体回归。
- **Workbench Components** · `Novel-Codex-Writer/frontend/src/components/WorkbenchView.tsx:66` — WorkbenchView.tsx 已达 729 行；模型定义约 50 个状态字段和约 39 个动作，同时编排主工作台、侧栏、编辑器、预览、右栏、项目 CRUD、ZIP 导入、预检、AI 设置和多种弹窗。当前行为未见错误，但变更影响面和耦合度已实质偏高。
- **Client API & Utilities** · `Novel-Codex-Writer/frontend/src/lib/format.ts:40` — getLineText 与 replaceLineRange 会把超出当前正文范围的行号静默裁剪到最后一行，而不是拒绝失效区间。调用方在比较裁剪后的文本后执行替换；若旧批注行号已越界且 before 恰好等于当前末行，作者确认后可能把建议写到错误的最后一行。现有测试仅覆盖有效行号。
- **Shared Contracts** · `Novel-Codex-Writer/frontend/shared/review-anchor.ts:1` — 行号超出正文范围时会静默裁剪到最后一行；同样裁剪逻辑也存在于 frontend/src/lib/format.ts。上层采用建议时可能把失效批注应用到错误行，契约层没有明确的越界拒绝语义。
- **Workflow Orchestration** · `Novel-Codex-Writer/frontend/server/workflow-api.ts:197` — isValidReviewProof 将空对象 context_revisions={} 判为有效，也未要求当前正文出现在其中；工作流状态可把缺少审阅上下文的 proof 标为 ready，随后由 Python canonical validator 才拒绝。
- **Workflow Orchestration** · `Novel-Codex-Writer/frontend/server/workflow-api.ts:203` — TypeScript 重复实现 review proof 与 chapter-result evidence 校验，而 canonical 逻辑位于 memory_patch_schema.py；两者已在 context_revisions 非空和正文绑定要求上发生漂移，形成协议双事实源。
- **Workflow Orchestration** · `Novel-Codex-Writer/frontend/server/workflow-api.ts:446` — 约 900 行文件同时承担 artifact 扫描、状态机、证据校验、Python 解释器发现、子进程生命周期和动作分发，高耦合已直接放大校验漂移。
- **Workflow Orchestration** · `Novel-Codex-Writer/frontend/server/workflow-api.ts:702` — Windows 请求路径使用 spawnSync 探测 py.exe，失败不缓存；launcher 异常时每次工作流动作都可能同步阻塞 Node 事件循环最多 10 秒。
- **Chapter Review Pipeline** · `Novel-Codex-Writer/frontend/server/chapter-review.ts:358` — 约 890 行模块仍集中承担上下文读取、确定性检查、AI schema 解析、事实核查、revision manifest 与运行记录规范化，职责边界过宽，维护性风险仍在。
- **Memory Core** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/memory_transactions.py:190` — 继承/普通锁续租与 lost event、staging/每次替换/恢复/回滚前 owner 复检已覆盖先前并发风险；当前主要维护风险仍是 788 行模块集中实现锁回收、事务 staging、提交、回滚和恢复，且 memory_patch_schema.py 仍约 760 行并混合记录、patch、ledger、proof、manifest 与历史选择职责，后续协议改动回归面较大。
- **Context Retrieval** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/build_context.py:1` — 单文件 653 行、25 个定义，同时承担 Markdown 解析、篇纲/细纲门禁、连续前章选择、索引检索、预算裁剪、任务书渲染、revision 元数据、事务写入和 CLI 编排；职责集中使规则变更与回归维护成本偏高。
- **Runtime & Delivery** · `Novel-Codex-Writer/frontend/server/system-preflight.ts:27` — Python 预检只按 PATH 调用 py/python；实际工作流优先使用 NOVEL_PYTHON_BIN、VIRTUAL_ENV 或固定绝对路径。无效配置或 PATH 差异会让预检显示通过，但实际动作返回 PYTHON_NOT_CONFIGURED。
- **Runtime & Delivery** · `Novel-Codex-Writer/frontend/server/system-preflight.ts:21` — 预检请求同步执行 spawnSync；Python 最多尝试两个命令并叠加 npm 探测，异常环境下最坏可阻塞 Node 事件循环约 15 秒。
- **Runtime & Delivery** · `Novel-Codex-Writer/scripts/windows/start_native.ps1:74` — Windows 原生启动只检查 vite.cmd 是否存在，不比较 package-lock 或依赖指纹；切换分支或更新 lockfile 后可能继续使用陈旧 node_modules。
- **Runtime & Delivery** · `Novel-Codex-Writer/scripts/windows/start_native.ps1:87` — 服务进程先启动，状态文件随后写入；状态写入失败会留下无状态孤儿进程，启动等待超时也未清理仍存活进程或状态文件。

### LOW (9)

- **Shared Contracts** · `Novel-Codex-Writer/frontend/shared/api-contract.ts:38` — WorkflowNextStep 是非判别联合：mode 为 server_action 时 serverAction 仍可选，类型不约束 id、mode 与 serverAction 的合法组合；畸形状态可通过类型检查并在客户端退化为不可执行。
- **Shared Contracts** · `Novel-Codex-Writer/frontend/src/types.ts:152` — ReviewFinding、ReviewSourceRef、ReviewContextManifestItem、ChapterReviewRun 等协议结构在服务端 chapter-review.ts 再次定义，未统一从 shared 导出，后续字段变更需同步两份。
- **Local API Gateway** · `Novel-Codex-Writer/frontend/server/novel-library-plugin.ts:343` — 网关主文件仍约 1651 行，集中注册路由并承载项目、文档、版本、回收站、导出、审阅、AI、设置和协议辅助编排；虽已抽出多个服务，核心修改半径仍偏大。
- **File Storage & Recovery** · `Novel-Codex-Writer/frontend/server/file-storage.ts:1` — file-storage.ts 当前约 843 行，同时承载路径安全、锁、文档读写、历史、回收站和 Markdown/ZIP 导出，职责面过宽，维护成本较高。
- **Workflow Orchestration** · `Novel-Codex-Writer/frontend/server/workflow-api.ts:294` — 仍保留 schema v1、legacy_unknown 和旧 patch_classifications 兼容读取及迁移写入；当前为有界只读兼容，但继续增加协议维护面。
- **Context Retrieval** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/build_context.py:119` — 仍保留 --max-section-chars 旧参数并映射到任务书总预算；当前有明确互斥校验和迁移提示，属于有界但仍在运行的 legacy 兼容面。
- **Chapter Checker** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/check_chapter.py:152` — strip_markdown/count_readable_words、重复段落和标点检查仍与TypeScript入口分别实现；共享规则JSON以及tests/test_chapter_checker_smoke.py:53-68和TS fixture测试已显著降低漂移风险，但算法修改仍需双边维护。
- **Chapter Checker** · `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/check_chapter.py:1` — 当前约487行，仍集中承担规则加载、CLI、路径与链接校验、Markdown计数、章节号解析、多类检查、报告渲染、锁和写入；职责相关但维护面偏大。
- **Runtime & Delivery** · `Novel-Codex-Writer/frontend/server/system-preflight.ts:80` — listener 检查无条件返回 pass，只把当前请求 localPort 当作监听证明并固定声明 127.0.0.1，没有验证预期端口、绑定地址或进程归属。

## Cross-cutting themes

- **上轮 P0 数据底座没有整体回归.** 正文、历史、作品索引和 Python 记忆事务仍保有跨进程锁、revision/hash 重检、原子替换与 canonical 路径边界；本轮未发现原有静默覆盖或 symlink 越界重新出现。
- **异步上下文成为新的数据安全薄弱点.** 长时间工作流完成后仍可能使用启动时捕获的 dirty 状态自动切换文档；连续性面板的手动请求也缺少项目代次校验。关键副作用需要统一绑定当前 project/document/revision。
- **工作流证据校验再次出现双事实源漂移.** TypeScript 状态层允许空任务书来源和空 context_revisions，Python canonical validator 更严格；前端可能显示 ready 而最终动作才失败，说明 fail-closed 契约尚未真正统一。
- **新增导入能力安全但确认不幂等.** ZIP 路径、大小、格式与覆盖保护较完整，但 staged token 在副作用完成后才删除；并发确认或超时重试可创建两个项目副本。
- **模块拆分有效但关键编排仍过宽.** App、Gateway、Workflow、Workbench 已提取多个 seam，然而 3 个核心模块仍降至 D；当前应修具体回归与契约漂移，不值得继续为文件行数做全面重写。
- **测试门禁强，但新控制器边界覆盖不足.** 现有单元、覆盖率、构建和 E2E 门禁持续有效；本轮高风险点恰好位于未覆盖的 useWorkflowController、越界行替换、导入并发和跨项目迟到响应。

