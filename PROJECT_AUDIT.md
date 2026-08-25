# webnovel-writer Skill V1 全面工程体检

> **历史基线说明：** 本文保留 2026-08-25 只读审计时的原始结论与分数，不能代表整改后的当前状态。P0.1–P3.1 的实施范围、验证证据和仍需外部处理的边界见 [`PROJECT_REMEDIATION.md`](PROJECT_REMEDIATION.md)。

> 审计日期：2026-08-25
> 审计基线：`main` / `58d423e3b1652a4c3eb51bee3bd14c3fb11acf74`
> 方法：Codemap + Code Overhaul + SonarQube Community Build 26.8 交叉验证
> 边界：只审计，不修改生产代码、测试源码、依赖、小说数据或远端仓库

## 1. Executive Summary

### 结论

当前项目属于：**可用 V1（仅限本机、单用户、单写者、人工在环）**。

综合健康度：**56 / 100**。

它不是 Demo：项目拥有完整的作品库、章节写作、记忆检索、审阅、版本历史、回收站、事务恢复、AI Provider 和前端工作台；本轮 37 个 Python 测试、44 个 Vitest 测试及 TypeScript/Vite 构建全部通过。

它也还不是“稳定 V1”：多个核心流程隐含假设“同一时刻只有一个写入者、输入来自可信前端、作品目录没有 junction/symlink、AI 返回格式基本正常”。当出现多标签页、重复点击、并发工作流、损坏元数据、错误 AI JSON 或不受信任的本地调用者时，系统存在覆盖正文、错误最终化、跨目录读取、重复计费或静默降级的风险。

### 当前为什么能够运行

1. **边界被实际使用方式收窄。** Vite 和宿主端口默认绑定 `127.0.0.1`，当前是受信任的个人本机应用，不是公网 SaaS。
2. **Markdown 是事实源。** 没有数据库服务或复杂迁移链，作品、记忆和工作流产物均可直接检查、复制和恢复。
3. **已有实用的数据保护。** 包括 project registry、路径词法检查、revision、原子 rename、正文历史、回收站、memory transaction manifest、patch 幂等和恢复诊断。
4. **关键规则相对明确。** Skill、AGENTS、章节最终化和记忆协议提供了完整的人工作业约束。
5. **测试对工具层有真实价值。** 文件存储、工作流状态、章节检查、记忆事务、搜索、review utility 等均有自动化测试。
6. **人工仍承担最后一道门禁。** 用户主动选择作品、确认审阅、检查正文和执行 memory patch，掩盖了部分缺失的系统级状态约束。

### 哪些部分可靠

- 当前受信任本机、串行使用下的作品读取、单次正文保存和基本恢复。
- 显式文档路径的词法边界与部分 symlink 防护。
- Markdown revision、历史版本、回收站不覆盖和原子替换思路。
- memory patch 的 schema、来源 revision、事务备份与显式恢复框架。
- 确定性章节检查、finding 去重、AI 结果基础字段清洗。
- 现有 Python/Vitest 测试和 TypeScript 构建。

### 哪些只是“目前碰巧没出问题”

- 多标签页、重复点击或多个 Python 进程同时写同一本小说。
- 项目目录、`.history`、正文、大纲或档案库中出现 junction/symlink。
- AI 返回空对象、部分 JSON、无证据的 verification 或损坏持久化记录。
- 浏览器取消请求后服务端 Provider 继续运行，以及重复点击造成重复计费。
- 小说规模明显增大后，搜索、状态查询、上下文、导出和索引的全量读取成本。
- 将服务暴露到局域网、公网、反向代理或多用户环境。

## 2. 审计范围与证据

### 实际覆盖

- Codemap：15 个功能模块、66 个一方功能文件、11,659 LoC；15/15 已独立审计，无空模块、过期模块或未审计模块。
- SonarQube：106 个文件、8 种语言、9,597 NCLOC；分析 ID `7b9f976a-546d-4fb9-b3c9-b2b14a894142`。
- Code Overhaul：架构、核心流程、数据、稳定性、测试、安全、性能、依赖、Dead/Legacy、Git 历史。
- 未读取 `.env` 内容，未调用真实 DeepSeek/Codex，未执行真实小说数据的故障注入或并发破坏测试。

### 验证结果

| 验证项 | 结果 |
|---|---:|
| `python -m compileall -q .` | 通过 |
| 根目录 Python tests | 20 / 20 通过 |
| `Novel-Codex-Writer/tests` | 17 / 17 通过 |
| Vitest | 44 / 44 通过（9 个文件） |
| `npm run build` | 通过，TypeScript + Vite，1,861 modules |
| Lint | 不可用：`package.json` 没有 lint script |
| Python coverage | 不可用：环境没有 `coverage` |
| Vitest coverage | 不可用：没有 `@vitest/coverage-v8` / Istanbul provider |
| `npm audit --omit=dev` | 2 个 High，均有可用修复 |
| 前端 dist | 954,365 bytes；逐文件 gzip 合计 308,302 bytes |

测试成功只证明当前测试覆盖的行为可运行，不代表真实 Provider、计费调用、并发写、junction/symlink、跨设备访问或生产部署已经验证。

## 3. 项目架构图

```text
用户
 │
 ▼
React 工作台 App.tsx
 │  状态 / 自动保存 / 搜索 / 审阅 / 恢复 / 工作流
 ▼
src/lib/api.ts ─────────────── Shared Contracts
 │ HTTP + NDJSON/SSE                │
 ▼                                  │
Vite Local API Gateway ◀────────────┘
novel-library-plugin.ts
 ├─ 作品库 / 文档 / 搜索
 │    └─ file-storage.ts
 │         ├─ Markdown 事实源
 │         ├─ .history
 │         └─ .trash / 导出
 ├─ 工作流状态
 │    └─ workflow-api.ts
 │         └─ Python 子进程
 │              ├─ build_context.py
 │              ├─ check_chapter.py
 │              ├─ update_memory.py
 │              ├─ compact_memory.py
 │              └─ memory_common.py
 │                   ├─ projects.json
 │                   ├─ current / 档案 / patch
 │                   ├─ memory_index.json
 │                   └─ .transactions
 └─ AI 审阅
      └─ chapter-review.ts
           ├─ 本地确定性检查
           ├─ 上下文与二次核查
           └─ DeepSeek API / Codex CLI
```

### 核心状态流

```text
细纲可用
  ↓
生成任务书
  ↓
编写正文
  ↓
章节检查与审阅
  ↓
生成提交记录 + memory_patch
  ↓
应用 patch + 写 finalization manifest
  ↓
下一章可使用本章结果
```

理想失败语义应是“任何来源不一致、产物损坏或验证不完整都进入 blocked/stale”。当前部分实现会把损坏当缺失、把无效 finding 丢弃、把 verification 失败降级，存在 fail-open 分支。

## 4. Codemap 模块健康度

| 模块 | 分数 | 等级 | 主要问题 |
|---|---:|:---:|---|
| Chapter Review Pipeline | 43 | D | malformed AI 结果可默认通过、上下文无总预算、验证降级 |
| File Storage & Recovery | 44 | D | 并发 TOCTOU、symlink、备份敏感文件、内存峰值 |
| Workflow Orchestration | 45 | D | 状态失真、最终化校验不完整、并发子进程 |
| Local API Gateway | 48 | D | 1,918 行 God Module、跨目录扫描、Provider 错误泄漏 |
| Chapter Checker | 51 | D | 输出路径过宽、TS/Python 规则漂移、误报 |
| Workbench App Shell | 52 | D | 1,352 行 God Component、状态竞态、重复 AI 请求 |
| Server Guards & Utilities | 54 | D | Host 信任、多字节 body 解码、双格式协议 |
| Memory Core | 54 | D | 1,376 行 God Module、并发事务、索引路径边界 |
| Memory Operations | 56 | D | 错误事务未统一阻断、重复变更计划算法 |
| Runtime & Delivery | 57 | D | CI 缺口、陈旧依赖 fallback、孤儿进程窗口 |
| Context Retrieval | 58 | D | 输出目标过宽、静默省略、任务书主函数臃肿 |
| Writing Skill Specification | 58 | D | 文档门禁未完全落实、legacy 语义未完整记录 |
| Workbench Components | 64 | C | 重复操作、异步响应竞态、键盘可访问性 |
| Shared Contracts | 66 | C | 前后端类型重复、NDJSON 协议未共享、dual-format |
| Client API & Utilities | 68 | C | 未验证泛型 JSON、重复流解析、取消能力不一致 |

Codemap 平均分约 **55 / 100**。结构耦合与质量分相互独立，但本项目的四个核心枢纽恰好也是最低分热点：Gateway、App Shell、Review Pipeline、Memory Core。

## 5. 项目健康度

| 维度 | 分数 | 依据 |
|---|---:|---|
| 架构合理性 | 6.0 / 10 | 本机单体符合规模；边界概念存在，但四个 God Module 跨越过多职责 |
| 业务逻辑 | 5.5 / 10 | 写作流程完整；状态机、最终化与 AI 验证存在 fail-open/错状态 |
| 代码质量 | 5.5 / 10 | 构建通过、重复率低；复杂度 2,160/2,652，262 smells，核心文件过大 |
| 数据设计 | 6.0 / 10 | revision、历史、事务、幂等设计正确；缺锁和提交前重检可能丢数据 |
| 稳定性 | 5.0 / 10 | 有恢复框架；重复执行、并发、子进程挂起、损坏 JSON 处理不一致 |
| 测试 | 6.0 / 10 | 81 个测试全部通过；主网关/App/E2E/并发缺失，CI 只跑根 Python |
| 安全性 | 5.0 / 10 | 当前回环绑定降低攻击面；历史隐私泄漏、symlink、备份和错误脱敏不足 |
| 性能与资源 | 6.0 / 10 | 当前小规模可用；多处全量读取、无界上下文、重复 AI 和导出内存峰值 |
| 可观测性 | 3.5 / 10 | 多处 silent catch/fallback；无结构化日志、任务追踪、指标和慢操作预算 |
| 文档与可维护性 | 7.5 / 10 | 文档与协议丰富；部分规范和实现漂移，核心模块修改半径过大 |
| **总分** | **56 / 100** | **可用 V1，不是稳定 V1** |

## 6. SonarQube 客观指标

| 指标 | 结果 | 解读 |
|---|---:|---|
| NCLOC | 9,597 | Sonar 支持语言的一方代码 |
| Bugs | 6 | 1 个条件恒等、5 个键盘可访问性问题 |
| Vulnerabilities | 2 | PATH 可写目录风险、Docker 默认 root |
| Security Hotspots | 0 | 不代表无安全风险；人工审计发现了 Sonar 未覆盖的业务边界问题 |
| Code Smells | 262 | 35 Critical、156 Major、79 Minor（总问题含 Bugs/Vulns 为 270） |
| Duplication | 0.6% | 整体低；`api.ts` 14.2%，`review-utils.ts` 9.5% |
| Coverage | 0.0% | 4,159 行待覆盖但无 LCOV/Cobertura；不能用来否定已通过的 81 个测试 |
| Cognitive Complexity | 2,160 | 高度集中在四个核心文件 |
| Cyclomatic Complexity | 2,652 | 高度集中在 App/Gateway/Memory/Review |
| Maintainability Rating | A | 债务率 0.6%；规则模型认为修复成本相对代码规模较低 |
| Reliability Rating | C | 6 个 Bugs |
| Security Rating | B | 2 个 Vulnerabilities |
| Technical Debt | 1,846 分钟 | 约 30 小时 46 分钟；仅代表 Sonar 规则估算，不含业务重构成本 |
| Quality Gate | OK | **条件列表为空**，因此不是发布批准，也不能抵消总体问题 |

### 复杂度最高的文件

| 文件 | NCLOC | Cognitive | Cyclomatic | Smells | Sonar Debt |
|---|---:|---:|---:|---:|---:|
| `memory_common.py` | 1,210 | 468 | 393 | 15 | 286 分钟 |
| `novel-library-plugin.ts` | 1,728 | 381 | 464 | 36 | 264 分钟 |
| `App.tsx` | 1,282 | 286 | 472 | 70 | 289 分钟 |
| `chapter-review.ts` | 698 | 166 | 241 | 11 | 89 分钟 |
| `ReviewPanel.tsx` | 285 | 133 | 134 | 33 | 158 分钟 |
| `workflow-api.ts` | 348 | 131 | 170 | 22 | 169 分钟 |
| `build_context.py` | 526 | 107 | 120 | 10 | 92 分钟 |

### 值得修的 Sonar 问题

1. `chapter-review.ts:458` 的恒等条件需要确认是否掩盖了 intended behavior。
2. `ReviewPanel.tsx:186/194/222/254/258` 的键盘交互缺失与人工可访问性审计一致。
3. `workflow-api.ts:286` 通过 PATH 解析 Python；当前本机影响较低，但固定解释器路径可同时改善安全和可重复性。
4. `memory_common.py`、`App.tsx`、`workflow-api.ts` 等高复杂度报告与 Codemap/人工审计一致，属于高置信技术债。
5. `postcss` 的任意 `.map` 文件读取公告有可用修复，虽主要影响构建期，仍应在独立依赖轮次升级。

### 低价值或需要降权的 Sonar 问题

- 把中文章节标题、文件名、`.transactions` 等重复字面量全部提取常量，收益很低。
- Cognitive Complexity 从 16 降至阈值 15，不应为过规则而拆分自然逻辑。
- Docker 默认 root 对当前仅本机开发容器是条件风险，不应机械引入复杂运行用户方案。
- Quality Gate 没有条件，`OK` 不能解释为“生产可发布”。

## 7. 三方交叉验证

| 高置信热点 | Codemap | Code Overhaul | SonarQube | 结论 |
|---|---|---|---|---|
| Memory Core | 54/D，God/bloat | 并发事务与索引路径风险 | Cognitive 468，最高 | P0/P1 数据核心热点 |
| Local API Gateway | 48/D，God/bloat | symlink、Provider 泄漏、保存竞态 | Cognitive 381，36 smells | P0/P1 核心边界热点 |
| App Shell | 52/D，God Component | 重复 AI、自动保存、状态竞态 | Cognitive 286，70 smells | P1/P2 前端编排热点 |
| Review Pipeline | 43/D | AI partial JSON、verification/finalization fail-open | 1 bug，Cognitive 166 | P1 核心正确性热点 |
| Workflow API | 45/D | 错状态、非 active 作品、无超时/锁 | 1 vulnerability，Cognitive 131 | P1 状态与执行热点 |
| File Storage | 44/D | TOCTOU、symlink、备份泄漏 | 无 Sonar bug/vuln | 人工审计不可被静态指标替代 |

## 8. 数据与持久化专项

项目没有关系数据库；数据库检查项对应到 Markdown/JSON 文件事实源：

- **Schema：** memory patch、AI suggestion/review、finalization manifest 存在 schema 或约定，但运行时并非全部严格执行。
- **主键：** `projectId`、`patch_id`、review/session id；重复章节文件和部分旧 patch 仍需要人工/兼容分类。
- **外键：** 由路径、chapter、revision、source manifest 模拟；不是数据库强约束。
- **唯一约束：** projects registry 和 patch 幂等有检查；同章多文件在不同入口处理不一致。
- **索引：** `memory_index.json` 是可重建投影；被篡改的索引项在一条加载路径缺少项目边界校验。
- **原子性：** `os.replace`/rename 防止半写，但 revision 检查与写入不在同一锁内，不能防并发丢更新。
- **回滚：** `.history`、`.trash`、`.transactions` 提供恢复；并发恢复和清理失败的可观测性不足。
- **Migration：** schema v1、`legacy_unknown`、旧 patch 分类和旧任务书仍存在；暂时不能直接删除。

## 9. 稳定性与故障模式

| 场景 | 当前行为 | 判断 |
|---|---|---|
| API 超时/断网 | 客户端部分支持 Abort；部分 GET 无 signal | 部分可恢复，旧响应仍可能覆盖新状态 |
| Provider 500/429 | 通常转为错误；无统一 retry/backoff | 不会静默成功，但用户重试可能重复计费 |
| AI 空/错误 JSON | suggestion 较严格；chapter review 会丢弃无效项后继续 | **高风险 fail-open** |
| AI 返回 Markdown | JSON parse 失败通常报错 | 可见失败，恢复依赖人工重试 |
| 字段缺失/null | 多处 normalize/filter；部分 completed 记录可变成空 findings/pass | 状态不可靠 |
| 文件损坏 | 部分 JSON catch 后当缺失；transaction 有诊断 | 处理不一致，可能隐藏损坏 |
| Python 子进程退出 | 非零码返回错误 | 可见失败，但 stdout/stderr 无上限 |
| Python 子进程挂起 | workflow `runPython` 无 timeout/cancel | 请求可能永久等待 |
| 任务中途失败 | transaction 可恢复；compact 对 error 级事务未统一阻断 | 有框架但门禁不一致 |
| 重复执行 | patch 有部分幂等；AI/工作流/恢复按钮无统一 in-flight/idempotency | 可能重复写或重复计费 |
| 程序重启 | Markdown 持久化；前端 in-flight 状态丢失 | 基本恢复，外部 Provider 状态不可协调 |
| 并发请求 | 无项目/文件/事务锁 | 可能覆盖正文、历史、projects registry、current/index |

## 10. 测试体系专项

### 已有价值

- 根测试覆盖仓库安全、Demo、章节检查和基础功能。
- 子项目 17 个 memory workflow 测试覆盖 transaction、revision、patch、恢复与上下文。
- 44 个 Vitest 覆盖 security utility、chapter review、file storage、workflow status、search、format、layout、review reconciliation。

### 核心缺口

- `novel-library-plugin.ts` 路由集成与真实 HTTP/SSE。
- `App.tsx`、React panels/editor 的组件行为和异步竞态。
- `src/lib/api.ts` 的坏 JSON、分片 UTF-8、NDJSON 中断与 cancellation。
- 并发 PUT、并发 restore、并发 `update_memory.py` / `compact_memory.py`。
- junction/symlink 经过真实入口的边界测试。
- Provider 429/500/timeout/partial JSON/重复点击与计费幂等。
- 浏览器 E2E：切换项目、保存、恢复、AI 不可用、最终化。
- CI 只运行根目录 20 个 Python 测试，漏掉子项目 17 个测试、44 个 Vitest 和 build。

Coverage 显示 0.0% 是“没有导入覆盖率报告”，不是“没有测试”。整改时应先接入现有测试报告，再决定覆盖率目标；不要为了百分比写无意义测试。

## 11. 安全专项

### 当前本机项目

默认回环绑定显著降低风险。`Host/Origin` 检查不能作为真正身份认证，但只要宿主始终绑定 `127.0.0.1`，远端利用条件较弱。

### 已确认风险

1. Git 历史存在已删除的私人小说目录，commit `521f97d...` 明确记录“Remove accidentally committed private novel data”；当前 `.gitignore` 不能清除历史对象。
2. 递归作品扫描、审阅上下文、历史、回收和导出对 junction/symlink 的真实路径校验不一致。
3. AI suggest/review 接受调用方 `content`，没有统一绑定磁盘 revision，可能送出路径与正文不匹配的数据。
4. Provider message/Codex stderr 只做路径脱敏，没有统一 key/token redaction。
5. 全量 ZIP 排除 `.env`，但未完整覆盖 `.env.local`、`.env.production`、`.key`、`.pem`、credentials 等。
6. `npm audit`：`postcss <=8.5.22` 有 source map 路径读取问题；transitive `nanoid <=3.3.17` 有非安全生成器无限循环公告。

### 如果转为局域网/公网/SaaS

当前安全模型不成立。届时 Authentication、Authorization、用户/作品隔离、CSRF、CORS、rate limit、审计日志、Provider 配额和真正的服务端身份边界都必须成为 P0；不能只在现有 Host/Origin 检查上叠补丁。

## 12. 性能与资源专项

- `/api/library` 对多个分组递归读取全部 Markdown；搜索每 260ms debounce 后仍会在服务端重新全量扫描。
- 浏览器 Abort 不会停止已在服务端运行的扫描或 Provider 调用。
- `documentCache` 缓存全文但无淘汰策略。
- 整章审阅读取前五章全文，使用 `Number.MAX_SAFE_INTEGER`，没有单文件/聚合上下文预算。
- 二次核查重复加载 current/archive/outline/前五章，并反复 lowercase/search。
- workflow status 重复读取任务书、patch、审阅上下文和前五章并计算 hash。
- memory index/diagnostics 对全库重复哈希，`read_bytes()` 会一次性加载完整文件。
- Markdown/ZIP 导出一次性读取并 `Buffer.concat`，大作品存在多份全量内存副本。
- 单次整章审阅最多调用两次 Provider；批量处理、重试和“换个回答”没有幂等键。
- 当前 bundle 约 954 KB，逐文件 gzip 约 308 KB；最大单块 CodeMirror core 为 458 KB（gzip 160 KB），对本地桌面工作台可接受，但应设置体积预算防回归。

## 13. 统一问题优先级

以下每个问题均含审计来源、发生概率、影响、收益、成本、风险和 Blast Radius。成本为相对估算，不是承诺工时。

| ID | 优先级与问题 | 文件/模块/来源 | 原因与实际影响 | 概率 | 收益 / 成本 / 修改风险 | Blast Radius | 推荐方案 |
|---|---|---|---|---|---|---|---|
| A01 | **P0 并发写可丢稿/丢状态** | `novel-library-plugin.ts:528-547,757-765`；`file-storage.ts:49-57,158-173`；`memory_common.py:1170-1227`；Gateway/Storage/Memory；Codemap+Overhaul | revision 检查、历史、写入和 transaction 没有同一锁/提交前重检；并发请求可同时通过旧 revision，后写覆盖先写 | 单人串行低；多标签/自动化中 | 收益极高；成本中；风险中（需字符化现有语义） | 正文、历史、projects registry、current、档案、索引 | 先写并发回归测试，再按 project/file 引入串行队列或锁，并在 commit 前重检 revision/hash |
| A02 | **P0 私人小说仍存在 Git 历史** | commit `521f97d...`；Repository Safety；Overhaul | 当前树已删除，但 clone/remote 历史可恢复原正文、档案和记忆 | 已发生 | 收益极高；成本中高；风险高（历史重写） | 所有已有 clone、远端分支/标签、缓存 | 先确认数据敏感性与远端传播范围；单独授权后备份并规划历史清理、协作者重新同步和必要凭据轮换 |
| A03 | **P1 审阅/最终化 fail-open** | `chapter-review.ts:482-520,620-653,677-703`；`workflow-api.ts:149-163`；`章节最终化.md:8`；Review/Workflow/Spec；三方共同发现 | 缺字段被丢弃、verification 无证据仍 confirmed、失败降为 S3、损坏 completed run 可变成 pass，文档门禁未统一执行 | 中 | 收益极高；成本中；风险中 | 审阅结论、最终化、后续章节上下文 | 统一 runtime schema；任何 malformed/缺来源/校验失败进入 blocked/unverified，最终化从同一验证函数取得证据 |
| A04 | **P1 symlink/junction 跨项目边界** | `novel-library-plugin.ts:669-715`；`file-storage.ts:82-128,176-184,338-349`；`chapter-review.ts:318-436,550-568`；Gateway/Storage/Review；Codemap+Overhaul | 显式文档有保护，递归扫描/上下文/导出未统一 canonical path 校验 | 本机低；不可信目录/多用户中高 | 收益高；成本中；风险低中 | 作品库读取、ZIP、AI 上下文、外部文件 | 提供唯一的 canonical walk/read helper；拒绝根或子项 symlink/junction，并用临时哨兵测试真实入口 |
| A05 | **P1 AI 请求未绑定磁盘正文** | `novel-library-plugin.ts:1311-1400`；`chapter-review.ts:353-375`；Gateway/Review；Codemap+Overhaul | 调用方可提交与 `documentPath` 不匹配的内容，revision/manifest 仍归因到真实章节 | 本地可信 UI 低；API 调用中 | 收益高；成本低中；风险低 | 当前请求内容、Provider 外传、审阅记录 | 请求携带 expectedRevision；服务端读磁盘并比较，或明确区分“未保存草稿审阅”并绑定 contentRevision |
| A06 | **P1 工作流状态与执行错误** | `workflow-api.ts:149-163,229-246,284-335`；Workflow；Codemap+Overhaul+Sonar | 缺正文仍可 ready；manifest 校验不完整；apply 非 active 作品缺 `--current-dir`；子进程无 timeout/锁 | 中 | 收益高；成本中；风险中 | 任务书、正文、patch、finalization | 建立显式状态转换表；fail closed；传递 projectRoot；为动作增加 timeout、取消和 per-project in-flight gate |
| A07 | **P1 Provider 错误可能泄漏敏感信息** | `novel-library-plugin.ts:1657-1723,1893-1910`；Gateway；Codemap+Overhaul | 上游 message/Codex stderr 可进入 HTTP/NDJSON，当前只脱敏本机路径 | 低中 | 收益高；成本低；风险低 | 单次请求响应、本机日志 | 错误分类后仅返回稳定 code；日志做 key/token/bearer/header redaction，并限制 stdout/stderr 大小 |
| A08 | **P1 核心路径缺少集成与并发测试** | `.github/workflows/ci.yml:31-35`；tests；Overhaul+Sonar Coverage | 81 测试通过但主网关/App/SSE/Provider/并发未覆盖，CI 只跑其中 20 个 | 高 | 收益高；成本中；风险低 | 所有后续整改 | 先把现有 37 Python + 44 Vitest + build 接入 CI；再补 A01/A03/A04 的临时目录集成测试和少量 E2E |
| A09 | **P2 四个 God Module 限制可维护性** | `App.tsx:107-1129`；`novel-library-plugin.ts:292-1918`；`memory_common.py:61-1376`；`chapter-review.ts:165-753`；三方共同发现 | 状态、路由、AI、文件、协议和恢复交织，修改半径大 | 已存在 | 收益高；成本高；风险高 | 前端、API、记忆、审阅主链路 | 不做全面重写；测试到位后按稳定 seam 逐个提取：状态/副作用、route handler、transaction/index、parse/verify |
| A10 | **P2 重复 AI/全量读取放大成本** | `App.tsx:284-402,729-790`；`chapter-review.ts:420-461,550-587`；`file-storage.ts:338-359`；Performance；Overhaul | 重复点击、取消不终止、搜索/状态/索引反复扫描、导出全量入内存 | 小作品低；规模增长中高 | 收益中高；成本中；风险中 | 延迟、内存、Token、Provider 账单 | 先加计数/耗时/上下文大小和 in-flight id；再做按 revision 缓存、服务端取消、流式导出和预算 |
| A11 | **P2 依赖与构建门禁缺口** | `package.json`、`package-lock.json`、CI；Overhaul+npm audit | 2 个 High 公告、15 个过时依赖；没有 lint/coverage/前端 CI | 中 | 收益中；成本低中；风险低中 | 构建与发布 | 独立依赖 PR：先修 PostCSS/nanoid 的兼容版本；Vite 6→8、TS 5→7 另做迁移，不混入安全补丁 |
| A12 | **P2 本机安全边界易被误用** | `api-security.ts:6-25`；`docker-compose.yml:13-24`；Security；Codemap+Overhaul | Host/Origin 可伪造；依赖宿主 127.0.0.1 才安全；容器挂载全项目并持有 Provider env | 当前低；暴露时高 | 收益中；成本低（声明/断言）到高（SaaS auth）；风险低 | 全作品库与 Provider | 当前先在启动时验证实际监听为回环并明确“非 SaaS”；若要远端访问，另立安全架构轮次 |
| A13 | **P2 缺少可观测性** | 多处 `catch → null/default`、子进程输出、启动状态；跨模块 | 配置损坏、清理失败、错误 transaction 和重复请求难以定位 | 中高 | 收益中；成本中；风险低 | 运维与恢复 | 定义结构化 error code、request/action id、耗时和恢复日志；敏感字段默认脱敏 |
| A14 | **P3 Dead/Legacy/规则噪声** | `format.ts`、`review-utils.ts`、CSS、legacy CLI/patch；Codemap+Overhaul+Sonar | 增加维护面但当前风险低；部分兼容仍可能有真实用户数据 | 已存在 | 收益低中；成本低；删除风险从低到高 | 局部工具与旧数据 | 只在调用统计、迁移盘点和回归测试后按批次删除；不要为 Sonar 字面量规则机械抽常量 |

### 影响 / 成本矩阵

```text
                 低成本                         高成本
高影响           A05 A07 A08 A11               A01 A02 A03 A04 A06
低影响           A13 A14                       A09 A10
```

## 14. 技术债 Top 10

按“风险 × 影响 × 未来维护成本 × 修改收益”排序：

1. 并发写入与 revision TOCTOU 可造成正文/记忆丢失。
2. 私人小说数据仍可从 Git 历史恢复。
3. AI 审阅与最终化存在 fail-open 数据路径。
4. 递归扫描、上下文和导出的 canonical path 防护不统一。
5. AI 内容未统一绑定磁盘正文与 revision。
6. 工作流状态机、非 active 作品和子进程生命周期错误。
7. Provider/Codex 错误缺少敏感信息脱敏与输出上限。
8. 核心链路缺少集成、并发、E2E 和 CI 门禁。
9. Gateway/App/Memory/Review 四个 God Module。
10. 重复 AI、全量扫描、无界上下文和导出内存峰值。

## 15. 删除候选清单

### 仓库内部可安全删除候选

仍应在独立整改轮次执行并跑完整测试：

- `frontend/src/lib/format.ts:8-46`：`formatBytes`、`formatDate`、`formatChapterWordCountRange`、`shortPath`、`describeEntry`，仓库内无调用。
- `frontend/server/review-utils.ts:4-19`：未引用的 `AI_SUGGESTION_SCHEMA` 常量。
- `frontend/src/styles.css:350-353,453`：无 JSX 使用的 `review-tabs`、`accepted-note`。
- `memory_common.py:44`：未引用的 `FINALIZATION_MANIFEST_RE`。
- `check_chapter.py:90-139`：未使用的本地 root resolver 副本与 `MemorySystemError` import。
- `check_chapter.py:82`：无行为的 `--strict` 参数；需先确认是否有外部脚本依赖 CLI 表面。

### 需要确认后删除

- `build_context.py` 的旧 `--max-section-chars`。
- schema v1、`legacy_unknown`、旧 `patch_classifications.json` 读取和旧任务书迁移。
- `package.json` 中源码未直接 import 的 `openai` 依赖；需确认是否被运行时/外部插件使用。
- Python/TS 两套章节规则之一；必须先决定唯一事实源和迁移入口。
- 历史设计截图与临时 QA 文档；先确认发布文档是否仍引用。

### 暂时不要删除

- `memory_common.py` 的 transaction、revision、manifest freshness 和 legacy migration。
- `file-storage.ts` 的 atomic write、history、trash 和 revision 保护。
- `api-security.ts` 的回环 Host/Origin 与请求体限制。
- `chapter-review.ts` 的确定性检查、finding 去重和 verification 状态。
- `workflow-api.ts` 的 revision-bound artifact 检查。
- `.gitignore` 的小说数据与 secret 规则。

## 16. 暂时不要动的地方

1. **不要把 Markdown 迁移成数据库。** 当前规模没有证据证明数据库能解决主要风险；锁、状态和 schema 门禁应先在现有模型补齐。
2. **不要全面重写 `memory_common.py`。** 它虽然复杂，但承载真实兼容与恢复语义；先用测试锁定事务、索引、patch 和 migration seam。
3. **不要移除 legacy patch 支持。** 尚未盘点真实作品库中的 schema v1/旧分类数据。
4. **不要为 0.6% duplication 引入大量抽象。** 只合并已产生行为漂移的规则、NDJSON 解析和 revision 校验。
5. **不要机械拆所有 Cognitive Complexity >15 的函数。** 优先拆同时具有业务风险、测试缺口和高耦合的函数。
6. **不要引入微服务、Kafka、Kubernetes、CQRS 或 Event Sourcing。** 当前问题是本机状态与边界，不是分布式吞吐。
7. **不要把项目直接升级为 SaaS 安全架构。** 除非产品目标确实变为多用户远端访问。

## 17. 整改路线图

每一轮均应独立提交、独立测试、可独立回滚；本报告不执行任何一轮。

### P0.1 Git 历史隐私处置

- 范围：只处理误提交的私人小说路径及远端传播。
- 前置：确认数据敏感性、远端/分支/标签、备份与协作者。
- 验收：全历史扫描不再包含目标路径；当前代码无变化；协作者有重新同步说明。
- 回滚：保留离线加密镜像；历史重写后只能通过镜像恢复。
- 风险：高，必须单独明确授权；禁止自动执行。

### P0.2 单写者与数据一致性

- 范围：正文保存、版本恢复、projects registry、memory transaction。
- 先写测试：同 expectedRevision 并发 PUT、恢复与保存并发、两个 memory 进程并发。
- 实现：per-project/per-file queue 或锁；提交前 revision/hash 重检；唯一临时文件名。
- 验收：所有并发用例只有一个提交成功，另一个明确 409/blocked；无丢稿。
- 回滚：移除锁层并保留新增 characterization tests。

### P1.1 审阅与最终化 fail-closed

- 范围：AI schema runtime validation、verification、stored run、finalization gate。
- 实现：malformed/缺来源/未验证均进入 blocked；统一文档和实现的 S1/S2 门禁。
- 验收：空 JSON、partial JSON、错误枚举、无 source、损坏 run、stale manifest 全部不能 pass/finalize。
- 回滚：保留旧记录读取 adapter，但新写路径只产生严格格式。

### P1.2 canonical path 安全边界

- 范围：library/context/history/trash/export/memory index。
- 实现：统一 canonical walk/read/write helper，拒绝 junction/symlink 越界。
- 验收：临时根指向外部哨兵的所有真实入口均拒绝，正常项目行为不变。
- 回滚：按入口开关恢复旧 walker；保留安全测试。

### P1.3 Provider 边界、脱敏与幂等

- 范围：suggest/review/verification/Codex subprocess。
- 实现：磁盘 revision 绑定、stable error code、secret redaction、输出上限、in-flight id、取消传播。
- 验收：错误日志/响应不含 key/token；重复点击只产生一次调用；取消可终止或明确标记后台继续。
- 回滚：保留旧调用 adapter，不改变 Provider 选择和 Prompt 业务语义。

### P1.4 工作流状态与子进程生命周期

- 范围：`workflow-api.ts` 状态表、非 active project、timeout/cancel。
- 验收：每个 artifact 组合有唯一预期状态；缺正文不能 ready；目标作品始终显式传递；挂起进程可超时回收。
- 回滚：状态计算函数可单文件回退；CLI 参数保持向后兼容。

### P1.5 测试和 CI 基线

- 第一阶段：CI 运行 37 Python、44 Vitest、build、npm audit 报告。
- 第二阶段：加入 coverage provider 和报告导入，不先设虚高阈值。
- 第三阶段：1–3 条关键 Playwright E2E。
- 验收：本轮已通过的命令全部成为 CI gate；覆盖率反映真实报告而非 0。

### P2.1 Gateway 分段

- 只提取 route registration、project/document service、AI provider adapter、session storage、error mapper。
- 不改变 URL、payload、文件格式或 Provider 行为。

### P2.2 App 状态与副作用分段

- 先提取 project/document lifecycle、review session persistence、AI request controller。
- UI 组件保持现有视觉；用组件/集成测试锁定切换和自动保存。

### P2.3 Memory Core 分段

- 按 registry/path、patch/schema、index/query、transaction/recovery、diagnostics 五个 seam 拆分。
- 先搬运后重构；每次只移动一个 seam，保持 CLI 输出和 Markdown 格式。

### P2.4 性能预算

- 加观测：扫描文件数/字节、上下文字符数、Provider 次数/耗时、导出峰值、bundle budget。
- 有数据后再做 revision cache、索引增量化、流式 ZIP、上下文上限和服务端取消。

### P2.5 依赖升级

- 先兼容升级 PostCSS/nanoid，验证 build/test。
- Vite 6→8、TypeScript 5→7 分开处理；不与安全或业务修复混合。

### P3.1 Dead/Legacy 清理

- 先做调用和真实作品格式盘点。
- 一批只删一种候选，保留完整测试和迁移说明。

## 18. Code Overhaul 选择建议

| 主题 | A（推荐） | B | C（延期） |
|---|---|---|---|
| 数据一致性 | **按文件/项目串行化 + revision 重检**：中成本、低架构负担 | 引入数据库事务：高成本、当前证据不足 | 保持单写者约定：零成本但继续承担丢稿风险 |
| 审阅协议 | **统一 runtime schema 并 fail closed**：中成本、高收益 | 仅补几个 if：低成本但漂移继续 | 依赖人工检查：风险高 |
| 路径安全 | **统一 canonical helper**：中成本、可测试 | 每个入口分别补：低初始成本、高维护负担 | 只写文档禁止 symlink：低收益 |
| God Module | **测试后按稳定 seam 渐进提取**：高成本、可回滚 | 全面重写：极高风险 | 不拆：短期稳定、长期成本继续增长 |
| Coverage | **先接入已有测试报告，再定目标** | 直接要求 80%：容易产生无意义测试 | 保持 0 指标：无法衡量回归网 |
| 依赖 | **安全补丁与大版本升级分轮次** | 一次升级全部：冲突与回归半径大 | 全部延期：保留已知公告 |

## 19. 不在本轮范围

- 修复、重构、删除或格式化生产代码。
- 修改测试源码、依赖或 CI。
- 清理 Git 历史、强制推送或远端协调。
- 真实 Provider 调用、账单验证或云端连通性声明。
- 真实小说数据的并发/损坏/junction 故障注入。
- 将本机产品改造为多用户 SaaS。
- 数据库、微服务、Kafka、Kubernetes、CQRS、Event Sourcing。

## 20. 尚未解决、以后可能反咬的问题

1. 产品是否永远只支持本机单用户？如果答案变化，安全优先级会整体上调。
2. 是否允许多个浏览器标签页或自动化工具同时操作同一本小说？当前实现没有明确承诺。
3. 未保存草稿能否送 AI 审阅？如果可以，必须明确与磁盘 revision 的双事实源语义。
4. schema v1、旧 patch 分类和旧任务书是否仍存在于真实作品库？删除前必须盘点。
5. 章节审阅中的 verification 失败应阻断还是降级？当前实现与“最终化必须可靠”的目标冲突。
6. Git 历史中的私人小说是否已推送、被 fork 或被第三方 clone？本地仓库无法单独回答。
7. Quality Gate 没有任何条件；是否需要在整改后建立适合本地 V1 的 gate？

## 21. 最终结论

这个项目能跑，是因为它已经建立了完整的写作工作流、文件事实源、revision/历史/事务保护、明确规范和一批有效测试，并且实际运行环境把它限制在可信本机、单用户、串行操作中。

最值得改的不是“让架构更高级”，而是：

1. 先消除真实的数据丢失与历史隐私风险。
2. 让审阅、最终化、路径和工作流在异常时 fail closed。
3. 把现有测试变成 CI 门禁，再补并发、边界和少量 E2E。
4. 最后按稳定 seam 渐进拆分四个 God Module，并用测量结果处理性能。

在上述 P0/P1 完成之前，项目应继续定位为 **可用 V1（本机单用户、人工在环）**，不应宣传为稳定 V1、生产级或可直接对外部署。

---

本轮到此停止。等待用户确认整改路线图后，才能进入任何修复、删除、依赖升级、提交、推送或 PR 操作。
