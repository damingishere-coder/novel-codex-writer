# P0.1–P3.1 工程整改验收记录

> 执行日期：2026-08-25 至 2026-08-26
> 原始审计：[`PROJECT_AUDIT.md`](PROJECT_AUDIT.md)
> 边界：未读取或修改真实小说内容，未调用真实 AI Provider，未写入任何 Token、API Key 或账号资料。

## 结论

原审计列出的 P0.1、P0.2、P1.1–P1.5、P2.1–P2.5、P3.1 已完成代码、测试、历史与工具链整改。项目仍定位为本机个人创作工具；本轮没有将其包装成多用户 SaaS，也没有引入数据库、微服务或不必要的分布式基础设施。

本机 SonarQube 已改为匿名本地扫描：`http://127.0.0.1:9000` 不再要求 SonarQube 账号、登录或 Token。该设置仅用于当前电脑上的本地实例，不改变项目自身的用户认证边界。

## 验收矩阵

| 编号 | 状态 | 主要实现与证据 |
|---|---|---|
| P0.1 Git 历史隐私处置 | 完成；有外部缓存边界 | 从全部可写本地/远端分支与标签历史移除 `Novel-Codex-Writer/小说项目/projects.json` 和已确认私人作品目录；`git rev-list --all --objects` 命中 0。改写前镜像保存在 `C:\Users\10578\AppData\Local\Codex\history-cleanup\webnovel-writer-20260825-p0-1\source.git`。GitHub 缓存、旧 clone 和不可写平台引用不能由普通 push 保证立即清除，见下文。 |
| P0.2 单写者与数据一致性 | 完成 | 正文/history/projects registry 使用跨进程锁、提交前 revision 重检和唯一临时文件；Memory 写入使用项目锁、事务 hash、锁所有权复检和原子恢复。并发测试验证一个提交成功、竞争者明确冲突或幂等跳过。 |
| P1.1 审阅与最终化 fail-closed | 完成 | AI 结果、二次核查、stored run、review proof、patch 与 finalization manifest 采用严格运行时校验；缺来源、布尔冒充整数、stale revision、损坏记录、未验证 S1/S2 均不能通过。 |
| P1.2 canonical path 边界 | 完成 | Node 和 Python 的扫描、读取、导出、索引、迁移、事务恢复统一走 canonical 项目边界；junction/symlink 外部哨兵在真实入口被拒绝。 |
| P1.3 Provider 边界 | 完成 | AI 请求绑定磁盘或显式草稿 revision；增加稳定错误码、secret/path 脱敏、1 MiB 输出上限、请求幂等键、in-flight 合并、取消与超时传播；Codex stderr 不再回显到 API。 |
| P1.4 工作流与子进程 | 完成 | 工作流状态由 artifact 状态表推导；目标作品始终显式传入；Python 使用实际解释器、每项目 gate、超时和取消；重复动作不会并发执行。 |
| P1.5 CI 与覆盖率 | 完成 | CI 运行 Python compile/test/coverage、Vitest coverage、TypeScript/Vite build、全部依赖 high-level 审计和关键 Playwright E2E，并上传报告；Python 与前端覆盖率采用当前真实基线的 ratchet 门禁，下降会让 CI 失败。 |
| P2.1 Gateway 分段 | 完成 | 从原服务入口提取 route registration、project/document service、Provider adapter、review session service、error mapper 和 observability；URL 与 payload 保持兼容。 |
| P2.2 App 副作用分段 | 完成 | 提取 project lifecycle、review session persistence、AI request controller 等 hooks；自动保存采用 functional updater、串行 pending 写入、请求代次与取消控制。 |
| P2.3 Memory Core 分段 | 完成 | 拆为 registry/path、patch/schema、index/query、transaction/recovery、diagnostics 五个 seam；`memory_common.py` 仅保留兼容 facade。 |
| P2.4 性能预算 | 完成 | 扫描文件/字节、上下文字符、Provider 次数/耗时、导出和 verification bundle 均有计数与硬上限；超限返回稳定错误。 |
| P2.5 依赖升级 | 完成 | Vite 升至 8.2.2、TypeScript 升至 7.0.2，PostCSS/nanoid 随 lockfile 修复；生产依赖审计为 0 个已知漏洞。 |
| P3.1 Dead/Legacy 清理 | 完成 | 零引用后删除未使用 helper、schema 常量、CSS 选择器和 `openai` 依赖；保留项、兼容原因和淘汰条件记录于 [`Novel-Codex-Writer/docs/legacy-compatibility.md`](Novel-Codex-Writer/docs/legacy-compatibility.md)。 |

## 关键安全行为

- 服务默认和宿主映射保持 `127.0.0.1`；容器内监听 `0.0.0.0` 时额外校验 socket 对端，只接受回环或容器私网对端，伪造 `Host: localhost` 不能越过边界。
- 显式文件和递归扫描都验证真实路径；外部 junction/symlink 不能被 library、整章审阅、workflow、export 或 Python memory 工具读取。
- 章节重名候选不再按文件名排序静默选第一个，而是返回 `409` 冲突。
- schema v2 `memory_patch` 文件仅是候选；只有同事务写入的应用凭据和新鲜 finalization manifest 才能进入章节摘要、上下文或篇末压缩。
- Provider 畸形 JSON、缺字段回答和上游错误使用稳定错误码；HTTP 与日志统一脱敏。
- Docker 开发容器改为非 root `node` 用户，只读挂载前端源码、Skill 和规则文件，读写范围收窄到 `.runtime` 与 `小说项目`，同时启用 `no-new-privileges`、移除 Linux capabilities；构建上下文排除运行状态、密钥文件与真实作品。
- 历史界面只读取最新 30 个不同 revision；历史目录最多 512 个版本、单版本最多 2 MiB、热点 30 版合计最多 64 MiB。系统不再在保存路径自动删除旧快照，达到硬上限时要求人工归档，避免并发清理误删。

## 自动化验证

最终验收使用隔离临时目录、假 Provider 和 E2E 示例作品，不访问真实小说：

- 根 Python：30 个测试通过。
- Memory workflow Python：52 个测试通过。
- Python branch coverage：40%，通过 30% CI ratchet；覆盖率验收首次出现 1 个时间窗口相关测试失败，清理覆盖数据后同组 30/30 重跑通过，作为剩余不确定性保留。
- Frontend Vitest：23 个测试文件、135 个测试通过；statements 41.62%、branches 36.94%、functions 35.09%、lines 44.89%，通过 statements 41%、branches 36%、functions 35%、lines 44% 的 CI ratchet（`coverage/lcov.info` 为忽略的临时产物，不提交）。
- TypeScript/Vite：生产构建通过。
- Playwright：3/3 通过，覆盖新建并打开作品、未保存正文的 revision 门禁，以及编辑保存后的磁盘/UI 同步；未调用真实 AI Provider。
- `npm audit --audit-level=high`：运行时和构建/测试依赖均为 0 个已知漏洞。
- Docker Compose YAML 解析通过；镜像构建语法阶段已进入基础镜像解析，但本机访问 Docker Hub 认证端点超时，无法在本轮完成完整镜像拉取/构建验证。
- SonarQube：最终指标见下节。

## Codemap 最终复核

- 15/15 模块已重新扫描、独立审计并标记为最新；无 stale、unaudited 或 empty 模块。
- 模块平均健康分从原审计约 55/100 提升到 97.6/100，15 个模块全部为 A。
- 剩余中等级维护性债务集中在 `workflow-api.ts`、`chapter-review.ts`、Memory transaction/schema 等大模块；低等级债务包括 Gateway、Storage、Workbench 的体量，以及前后端审阅类型的重复维护。它们未被误报为已经彻底消失，详见 [`.codemap/codemap.md`](.codemap/codemap.md)。

## SonarQube 本地扫描

- 地址：`http://127.0.0.1:9000/dashboard?id=webnovel-writer-skill-v1-audit`
- 实例：SonarQube Community Build 26.8.0.126808。
- 认证：本机匿名访问；scanner 命令不包含 `sonar.login`、`sonar.token`、账号或环境变量。
- 最终 CE task：`75f456a2-3ce2-4246-86ec-6411dbafd6e9`，状态 `SUCCESS`；analysis：`5c911e65-ea6e-4153-91b8-d6176e9df630`。
- 指标：14,508 ncloc；总覆盖率 40.5%（line 43.9%、branch 35.9%）；Bugs 0、Vulnerabilities 0、Security Hotspots 0；Reliability / Security / Maintainability ratings 均为 A；重复行密度 0.1%。
- Code Smells 共 350 个，全部属于维护性提示，不是 Bug 或 Vulnerability；其中本轮新代码期 210 个。
- 默认 Quality Gate：`ERROR`。原因是新代码覆盖率 45.3% 低于默认 80%，且默认“新问题为 0”条件检测到 210 个新维护性提示；扫描成功不等于门禁通过。
- 扫描范围和覆盖率导入配置：[`sonar-project.properties`](sonar-project.properties)。
- CI 门禁：GitHub 托管 runner 无法访问本机 `127.0.0.1:9000`，因此不伪装成远程 Sonar 门禁；CI 直接校验 Python ≥30%、前端 statements ≥41%、branches ≥36%、functions ≥35%、lines ≥44%，本机 Sonar 在最终验收时另行扫描。
- 说明：Quality Gate 同时评估“新代码覆盖率 80%”和“新问题为 0”等默认门槛；门禁状态与 Bugs/Vulnerabilities 指标必须分别阅读，不能把扫描成功误报为门禁通过。

## P0.1 外部残余边界

当前可写 `main`、分支和标签已经完成改写并验证；但 GitHub 文档明确说明，敏感数据历史重写不能自动撤回已有 clone、fork、缓存页面或平台生成的只读引用。远端仍存在 `refs/pull/1/head`、`2/head`、`3/head`、`4/head`、`6/head`；这些引用不可由普通用户 force-push。当前对这些 tip 的本地可达对象扫描未再次命中目标路径，但若私人内容曾被公开或分享，仍应按 GitHub 官方流程联系 Support 清理缓存，并要求协作者重新 clone，不能把“当前树干净”当成传播撤回证明。

## 回滚与迁移

- Git 历史只能从离线镜像恢复；不要把该镜像重新推回远端。
- 新锁、schema 和 manifest 都保留旧格式读取 adapter；新写入只产生严格格式。
- 如需移除某个 legacy adapter，先满足 `legacy-compatibility.md` 中的迁移命令、真实旧格式 fixture 和全套回归门禁。
- 本轮未修改任何 `小说项目/作品/**`、本地 `.env`、AI 密钥或真实 Provider 账户配置。
