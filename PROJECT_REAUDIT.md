# webnovel-writer Skill 整改后二次工程复检

> 复检日期：2026-08-30
> 代码基线：`main` / `f8eb31e1719e33031fd62dda640f9608113c8dc5`
> 对比基线：[`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) 与 [`PROJECT_REMEDIATION.md`](PROJECT_REMEDIATION.md)
> 方法：Codemap + Code Overhaul + SonarQube Community Build 26.8.0.126808
> 边界：本轮只复检；没有修改生产代码、测试源码、依赖、运行配置或小说数据，只更新复检报告与 `.codemap` 审计产物，没有调用真实 AI Provider。

## 1. 最终结论

当前综合健康度：**82 / 100**，较首次体检的 **56 / 100 提升 26 分**。

项目已经从“可用但存在明确数据安全缺口的 V1”提升为：**本机、单用户、人工在环场景下整体稳定的 V1**。上轮最危险的数据底座问题——并发覆盖、canonical path 越界、AI 内容归因、Provider 错误泄漏——没有发现重新出现；测试、覆盖率、CI、依赖安全和恢复能力也都明显增强。

但本轮不能直接宣布“所有优化结束”。最新功能扩展后出现了 **3 个 HIGH 风险点**：

1. 长工作流完成后的旧闭包可能切换文档，造成未保存草稿现场丢失。
2. ZIP 导入确认 token 可以被并发消费，可能重复创建作品。
3. TypeScript 工作流状态层与 Python canonical validator 再次漂移，可能把证据不完整的任务书/审阅证明显示为 ready。

因此建议是：**停止广泛重构和代码洁癖式优化，只做一轮窄范围回归修复；3 个 HIGH 和两个直接关联的数据错配边界关闭后，本轮即可停止。**

## 2. 本轮复检范围与限制

### 已重新扫描

- Codemap：15 个功能模块，111 个纳入映射的文件，19,336 tracked LoC；15/15 模块均为当前基线，0 stale、0 unaudited、0 empty。
- Code Overhaul：架构、业务正确性、数据安全、异步状态、测试、性能、依赖、交付脚本、Dead/Legacy 和 Git/CI 状态。
- SonarQube：70 个纳入分析的源文件、4 种语言、16,051 NCLOC；成功导入 Python Cobertura 与前端 LCOV。
- 动态验证：82 个 Python 测试、162 个 Vitest、6 个 Playwright、TypeScript/Vite 生产构建、依赖安全审计及当前提交的 GitHub CI。

### 未做的事情

- 未读取或修改真实小说正文、档案、记忆库和 Provider 密钥。
- 未调用真实 DeepSeek/Codex，不验证真实计费、上游限流或响应丢失后的远端状态。
- 未在真实作品上执行并发写入、损坏文件、断电或 junction/symlink 故障注入。
- 未把本机服务暴露到局域网或公网；本报告不把当前架构评价为多用户 SaaS。

## 3. 上次问题解决了多少

首次体检的 P0/P1/P2 共 **13 项（A01–A13）**：

- **6 项已完全关闭**：A01、A03、A04、A05、A06、A07。
- **7 项已部分关闭或保留明确边界**：A02、A08、A09、A10、A11、A12、A13。
- **0 项完全未处理**。

这里的“完全关闭”只评价上次记录的具体故障，不等于相邻模块永远不会出现新问题。本轮发现的工作流校验漂移和异步闭包问题属于后续功能扩展产生的新风险，已单独列入第 6 节。

| 编号 | 上次问题 | 当前状态 | 本轮证据与结论 |
|---|---|---|---|
| A01 | 并发写可丢稿/丢状态 | **已关闭** | 正文、history、projects registry、Memory transaction 仍有跨进程锁、提交前 revision/hash 重检、唯一临时文件与原子替换；对应并发测试继续通过。 |
| A02 | 私人小说存在 Git 历史 | **部分关闭** | 当前可写分支/标签与普通远端历史已清理；既有 clone、平台缓存和不可写引用是否全部撤回仍不能由仓库内证据证明。这是外部传播边界，不是继续改业务代码能解决的问题。 |
| A03 | 审阅/最终化 fail-open | **原问题已关闭** | 上轮的 malformed AI、缺来源 verification、损坏 completed run、stale revision 等路径仍 fail-closed。当前发现的是后来新增的 TypeScript 状态摘要校验与 Python canonical validator 漂移，见 R03。 |
| A04 | symlink/junction 跨项目边界 | **已关闭** | 关键扫描、读取、导出、索引和事务入口继续经过 canonical project boundary；未发现旧越界路径回归。 |
| A05 | AI 请求未绑定磁盘正文 | **已关闭** | 磁盘正文或显式草稿 revision/content revision 绑定仍存在，审阅记录不会把任意请求正文归因到当前磁盘章节。 |
| A06 | 工作流状态与执行错误 | **原问题已关闭** | 缺正文、非 active 项目、解释器选择、timeout/cancel 和 per-project gate 的上轮缺口已修复并有测试；新证据契约漂移与预检差异见 R03、R07。 |
| A07 | Provider 错误泄漏敏感信息 | **已关闭** | 稳定错误码、key/token/path 脱敏、输出上限和 Codex stderr 隔离仍在；本轮静态扫描未发现新的 secret 硬编码。 |
| A08 | 核心路径缺集成/并发测试 | **部分关闭** | 当前 82 Python + 162 Vitest + 6 Playwright + build 已纳入验证，当前 SHA 的 GitHub CI 通过；但新增异步闭包、导入并发、越界行号和跨项目迟到响应尚无回归测试。 |
| A09 | 四个 God Module | **部分关闭** | 已提取 project/document service、review/provider service、多个 hooks 和 Memory seam；原始巨型模块明显缩小，但 App/Gateway/Workflow/Workbench 仍是高变更半径。当前只应围绕具体 Bug 切 seam，不建议继续为行数重写。 |
| A10 | 重复 AI/全量读取放大成本 | **部分关闭** | 已加入预算、上限、in-flight 合并、取消和耗时计数；但响应丢失后的用户重试会生成新 idempotency key，仍可能重复计费，且少量同步探测会阻塞 Node。 |
| A11 | 依赖与构建门禁缺口 | **部分关闭** | `npm audit` 为 0，覆盖率、构建和 E2E 门禁已建立；无 lint script 且仍有非紧急大版本升级，但当前没有证据表明必须为此再开整改。 |
| A12 | 本机安全边界易被误用 | **部分关闭** | 回环绑定、容器约束和本地调用边界已有防护；远程、多用户、鉴权、CSRF 等仍明确不在当前产品定位内。只要不改变部署边界，不需要继续扩建 SaaS 安全层。 |
| A13 | 缺少可观测性 | **部分关闭** | request/action id、稳定错误码、耗时、恢复诊断和脱敏日志已补齐一部分；仍未形成集中式观测系统，但本机单用户工具当前不值得为此引入完整平台。 |

## 4. Codemap 前后变化

| 阶段 | 平均分 | 分布 | 解读 |
|---|---:|---|---|
| 首次体检 | 约 55 | 多个 D/C | 并发、边界、fail-open 与巨型模块同时存在。 |
| 整改验收 | 97.6 | 15 个 A | 上轮已知问题在当时基线全部完成整改与验收。 |
| 本次复检 | **84.8** | A×8、B×4、D×3 | 写作引擎和存储底座保持强健；后续新增的工作台、导入和工作流状态逻辑拉低前端/服务端编排层。 |

当前最低的三个模块：

| 模块 | 分数 | 为什么下降 | 是否需要大重构 |
|---|---:|---|---|
| Workflow Orchestration | 48/D | 任务书与 review proof 校验和 Python 事实源漂移；文件仍同时编排状态、证据、解释器和子进程。 | **否**。先统一证据 validator 并补契约测试。 |
| Workbench App Shell | 58/D | 长异步动作使用旧 render closure，可能覆盖当前编辑现场；根状态面仍偏宽。 | **否**。修复请求代次/草稿 revision 绑定即可。 |
| Local API Gateway | 58/D | 新增 ZIP 导入 token 在副作用后才消费，缺并发幂等；主路由文件仍较大。 | **否**。原子消费 token 并补并发测试即可。 |

Codemap 下降不表示上轮底层整改失效。Memory、Storage、Review、Context 等核心模块仍为 93–100；下降主要来自新增功能的具体回归和编排层继续增长。详见 [`.codemap/codemap.md`](.codemap/codemap.md) 与 [`.codemap/codemap.html`](.codemap/codemap.html)。

## 5. SonarQube 前后指标

| 指标 | 首次体检 | 整改验收 | 本次复检 | 变化解读 |
|---|---:|---:|---:|---|
| NCLOC | 9,597 | 14,508 | **16,051** | 较整改验收增加 1,543（10.6%），主要来自写作驾驶舱、安全导入和预检等新功能。 |
| Coverage | 0.0%（未导入报告） | 40.5% | **42.3%** | 较整改验收提升 1.8 个百分点。 |
| Line coverage | 未导入 | 43.9% | **45.7%** | 提升 1.8 个百分点。 |
| Branch coverage | 未导入 | 35.9% | **38.0%** | 提升 2.1 个百分点。 |
| Bugs | 6 | 0 | **2** | 新增 2 个 `MemoryPanel.tsx` 字符串排序规则 Bug；Reliability 因此降级。 |
| Vulnerabilities | 2 | 0 | **0** | 保持为 0。 |
| Security Hotspots | 0 | 0 | **0** | 保持为 0；不替代业务安全人工审计。 |
| Code Smells | 262 | 350 | **389** | 较整改验收增加 39；同时代码规模增加 10.6%。多数是维护性提示，不建议逐条机械清理。 |
| Duplication | 0.6% | 0.1% | **0.1%** | 保持低水平，没有出现系统性复制粘贴回归。 |
| Reliability | C | A | **D** | 由 2 个 Critical `Array.sort()` 字符串排序问题导致。 |
| Security | B | A | **A** | 保持 A。 |
| Maintainability | A | A | **A** | 保持 A；技术债估算 2,982 分钟，只适合做趋势参考。 |
| Cognitive complexity | 2,160 | 未记录 | **4,181** | 绝对值随规模上升，且编排层集中度仍高；只应处理与真实故障绑定的热点。 |
| Cyclomatic complexity | 2,652 | 未记录 | **5,193** | 同上，不建议为数字本身全面拆文件。 |
| Quality Gate | OK（无条件） | ERROR | **OK** | 当前使用 `Sonar way` 与 `PREVIOUS_VERSION` 新代码期，本次 API 返回 0 个生效条件；只能说明本次没有触发门禁条件，不能抵消 2 Bugs 和人工发现。 |

本次 scanner exit code 为 0，CE task 为 `cd27ba8e-dfd6-44cc-b90b-206ddf588f91`，分析绑定 SCM revision `f8eb31e1719e33031fd62dda640f9608113c8dc5`。扫描使用一次性本机 token，结果读取后已撤销；隔离端口关闭，SonarQube 原配置已恢复。

两个 Sonar Bug 都位于 `MemoryPanel.tsx:59-60`：字符串数组直接使用默认 `sort()`。这会依赖 UTF-16 code unit 顺序，跨语言显示顺序可能不符合预期；修复成本很低，但它不如第 6 节前三项紧急。

## 6. 目前仍值得继续处理的问题

### R01 · HIGH · 长工作流可能覆盖未保存草稿现场

- 证据：`frontend/src/hooks/useWorkflowController.ts:108-131`、`frontend/src/App.tsx:359-367`。
- 触发：启动耗时工作流后继续编辑；请求完成时仍由启动请求时捕获的旧 `onOpenPath`/`dirty` 闭包决定是否切换产物。
- 后果：旧闭包可能认为没有未保存内容，自动打开产物并切换路径，当前编辑现场丢失。
- 建议：完成回调必须比较当前 project、document、draft revision/dirty generation；不匹配时只提示“产物已生成”，禁止自动切换。
- 验收：用可控延迟请求覆盖“动作中继续编辑”，确认正文、选中路径和 dirty 状态均不变。

### R02 · HIGH · ZIP 导入确认 token 缺少原子消费

- 证据：`frontend/server/project-import.ts:257-268`。
- 触发：两个确认请求同时到达，或服务器已完成导入但客户端因响应丢失再次提交。
- 后果：两个请求都可在 token 删除前进入 `importProject`，创建两个不同 projectId 的重复作品。
- 建议：在任何导入副作用前原子地把 token 从 `staged` 转为 `consuming`；后续请求返回同一结果或明确冲突，失败时按状态机安全恢复。
- 验收：加入并发 `Promise.all`、响应丢失重试和失败恢复测试，证明最多创建一个作品。

### R03 · HIGH · 工作流证据校验出现双事实源漂移

- 证据：`frontend/server/workflow-api.ts:130-158,197-218` 与 Python `memory_patch_schema.py:512-516`。
- 现状：TypeScript 允许任务书 `sources=[]`；空对象 `context_revisions={}` 因 vacuous truth 被判有效，也不要求当前正文 revision。Python canonical validator 更严格。
- 后果：UI/状态 API 可以显示 ready，但最终动作才被 Python 拒绝；更危险的是未来若某入口只信任 TypeScript 摘要，fail-closed 可能退化。
- 建议：只保留一个 canonical 证据契约；TypeScript 状态层调用同一 schema/共享 fixture，至少强制非空来源、当前正文绑定和 metadata schema version。
- 验收：TS/Python 共用正反例 fixture，空 sources、空 context、缺 body、stale body 在两端都必须 blocked。

### R04 · MEDIUM · 失效行号可能把建议应用到错误末行

- 证据：`frontend/src/lib/format.ts:40-52`、`frontend/shared/review-anchor.ts:1-15`。
- 现状：越界行号被静默裁剪到最后一行；若旧 finding 的 `before` 恰好等于当前末行，比较会通过并替换错误位置。
- 建议：把“展示时裁剪”与“写入时严格拒绝”分开；应用建议时越界必须返回 stale/conflict。
- 验收：补行数缩短、空正文、越界且末行同文本的反例测试。

### R05 · MEDIUM · 手动 Memory 请求可能跨项目回写旧响应

- 证据：`frontend/src/components/MemoryPanel.tsx:34-57,77-90`。
- 现状：自动加载有 abort，但手动 refresh/consistency 请求没有 AbortSignal 或 project generation 校验。
- 后果：项目切换后，旧项目的迟到响应可能显示在新项目面板中，形成误读。
- 建议：所有请求统一绑定 projectId + request generation；切换项目时 abort，响应提交前再次比较当前 projectId。
- 验收：可控延迟下先请求 A 再切 B，A 的响应不得进入 B 的 UI。

### R06 · MEDIUM（启用真实计费 Provider 时）· 响应丢失后的重试仍可能重复计费

- 证据：服务端 `withAiRequest` 只合并 in-flight；客户端每次重试生成新的 UUID。
- 触发：Provider 已完成且计费，但 HTTP/SSE 响应丢失，用户点击重试。
- 后果：新 key 会发起第二次真实 Provider 调用。
- 建议：把一次用户意图的 idempotency key 保留到获得明确终态；服务端短期缓存已完成结果。若只使用本地/免费 Provider，可降级处理。

### R07 · MEDIUM（Windows 原生启动为主路径时）· 预检和启动状态不完全可信

- 证据：`frontend/server/system-preflight.ts:21-31,80`、`scripts/windows/start_native.ps1:74-120`。
- 现状：预检只查 PATH，但真实工作流还读取 `NOVEL_PYTHON_BIN`/venv/固定路径；同步探测最多阻塞约 15 秒。启动脚本只看 `vite.cmd` 是否存在，不校验 lockfile，且状态文件写失败/启动超时可能遗留无状态进程。
- 建议：复用工作流的解释器解析函数；依赖用 lock hash 判定；启动失败路径清理确切 PID，并用真实 listener owner/绑定地址验收。
- 验收：无效 `NOVEL_PYTHON_BIN`、陈旧 `node_modules`、状态写失败和端口被其他进程占用均必须 fail-closed。

## 7. 新回归风险判断

**有新回归风险，但没有证据表明旧数据底座整体回退。**

新风险主要来自整改后新增或扩展的工作台、ZIP 导入、Memory 面板和工作流状态层：

- R01、R02、R05 是典型的“异步请求完成时上下文已经变化”。
- R03 是前后端/跨语言重复验证造成的事实源漂移。
- R04 是读取便利语义被错误复用于写入语义。
- R06、R07 是原有边界已改善但尚未达到完整幂等/可诊断启动的残余风险。

当前测试全部通过，说明这些不是大面积运行时破坏，而是**尚未进入测试矩阵的高价值边界条件**。修复应直接围绕上述可复现条件补测试，不需要重写整套架构。

## 8. 验证结果

| 验证项 | 本次结果 | 对比 |
|---|---:|---|
| Python compileall | 通过 | 无语法回归。 |
| 根目录 Python tests | 30 / 30 | 与整改验收一致。 |
| Memory workflow Python tests | 52 / 52 | 与整改验收一致。 |
| Python branch coverage | 40% | 通过 ≥30% gate。 |
| Vitest | 162 / 162（28 files） | 整改验收为 135 tests；新增测试已纳入。 |
| Frontend statements | 44.06% | 41.62% → **+2.44pp**。 |
| Frontend branches | 39.40% | 36.94% → **+2.46pp**。 |
| Frontend functions | 36.12% | 35.09% → **+1.03pp**。 |
| Frontend lines | 47.60% | 44.89% → **+2.71pp**。 |
| TypeScript/Vite build | 通过，1,858 modules | 无构建回归。 |
| Playwright | 6 / 6 | 整改验收为 3/3；关键 UI 路径增加。 |
| `npm audit --audit-level=high` | 0 vulnerabilities | 保持干净。 |
| 当前 SHA GitHub CI | 通过 | Run `33056503007`。 |
| SonarScanner | 成功 | 绑定当前 SHA，Coverage 报告已导入。 |

这些成功结果不能覆盖真实 Provider、响应丢失、并发导入、长动作期间继续编辑和跨项目迟到响应；这些正是下一轮窄修复应补的测试。

## 9. 影响 / 成本决策矩阵

| 优先级 | 问题 | 用户影响 | 修复成本 | 决策 |
|---|---|---:|---:|---|
| 1 | R01 未保存草稿现场丢失 | 极高 | 低—中 | 必修，先做。 |
| 2 | R02 导入 token 并发消费 | 高 | 中 | 必修。 |
| 3 | R03 工作流证据契约漂移 | 高 | 中 | 必修。 |
| 4 | R04 越界建议写错行 | 中高 | 低 | 与 R01 同轮修。 |
| 5 | R05 跨项目迟到响应 | 中 | 低 | 与 R01 同轮修。 |
| 6 | R06 Provider 终态幂等 | 高但触发较窄 | 中 | 真实计费 Provider 启用前修。 |
| 7 | R07 Windows 启动可靠性 | 中 | 中 | 若 Windows 原生脚本是主要入口则修；否则可延后。 |
| 不单列 | Sonar 两个字符串排序 Bug | 低 | 极低 | 在上述修复轮顺手处理，不单独立项。 |

## 10. 明确不建议继续做的优化

以下工作当前收益不足，不应为了分数或代码洁癖继续推进：

- 不全面重写 App、Gateway、Workflow、Workbench、Memory 或 Review 大模块。
- 不为降低 Sonar Code Smells 机械抽常量、改措辞或拆小函数。
- 不因“有新版本”直接升级 React 19、Tailwind 4、Lucide 1.x 等大版本。
- 不为本机单用户工具引入数据库、微服务、消息队列、集中日志平台或完整 SaaS 鉴权。
- 不因当前 bundle 体积做专项优化；没有真实性能证据证明它已影响写作流程。
- 不删除仍有兼容价值的 schema v1、旧 CLI 参数和历史数据读取路径；只在有迁移统计和淘汰计划时处理。
- 不追求任意覆盖率数字；只为 R01–R07 的失败模式补有意义的回归测试。

## 11. 建议执行顺序、迁移与回滚

若开启下一轮窄修复，建议按以下顺序：

1. 先为 R01/R04/R05 建立可控延迟和 stale-context 测试，再统一前端 request generation / draft revision 门禁。
2. 为 R02 建立并发消费测试，再实现 token 状态机；不要改变 ZIP 格式或已有导入 API。
3. 为 R03 建立 TS/Python 共用 fixture，再收敛 validator；保持旧产物只读兼容，失败时返回明确 blocked 原因。
4. 根据真实 Provider/Windows 运行方式决定是否同轮完成 R06/R07。
5. 重跑本报告第 8 节全套验证，并再次检查 Sonar 的 2 Bugs 和 Codemap 三个 D 模块是否因具体风险关闭而回升。

所有建议都可以局部回滚：前端只需撤销代次门禁实现，导入只需恢复旧 token 消费逻辑，workflow validator 保留旧产物兼容读取。不要通过数据库迁移、格式破坏或全模块重写来解决这些问题。

## 12. 是否可以停止本轮优化

**现在：还不能完全停止。** 原因不是分数不够，也不是模块太大，而是仍有 3 个可导致数据错配、重复副作用或 fail-closed 退化的 HIGH 问题。

**可以立即停止的部分：** 广泛架构重构、依赖追新、Sonar 清零、覆盖率刷分和通用代码整理。

**达到停止条件：** R01、R02、R03 关闭；R04、R05 有回归测试并关闭；真实计费 Provider/Windows 原生入口若在当前使用范围内，则分别完成 R06/R07，否则把它们记录为启用条件。届时只要全套测试、构建、CI 和本机 Sonar 复验保持通过，就可以明确结束本轮优化。

换句话说：**项目已经不需要“继续大改”，只需要一次小而精确的收尾修复。**
