# P0.1-P3.1 全量整改执行任务

## 背景

`PROJECT_AUDIT.md` 将当前版本判定为仅适合本机、单用户、单写者、人工在环的可用 V1。用户已明确授权从 P0.1 到 P3.1 全部整改。本任务采用渐进、可验证、可回滚的 FULL 模式，不进行大爆炸重写。

## 总目标

完成 `PROJECT_AUDIT.md` 第 17 节列出的 P0.1、P0.2、P1.1-P1.5、P2.1-P2.5、P3.1，并以测试、构建、Codemap、SonarQube、Git 历史和远端引用的当前证据逐项验收。

## 允许修改范围

- 根目录：`.github/workflows/ci.yml`、`.gitignore`、`PROJECT_AUDIT.md`、审计/整改文档。
- `Novel-Codex-Writer/frontend/server/**`。
- `Novel-Codex-Writer/frontend/src/**`。
- `Novel-Codex-Writer/frontend/package.json` 与 lockfile。
- `Novel-Codex-Writer/.agents/skills/webnovel-writer/scripts/**`。
- 与上述行为直接对应的根/子项目测试、少量测试配置和 CI 配置。
- `.codemap/**`；HTML/Markdown 只能由 Codemap 脚本从 `modules.json` 生成。
- P0.1 所需的 Git 本地与远端分支/标签历史；仅移除已确认的私人小说路径。

## 禁止修改范围

- `Novel-Codex-Writer/小说项目/作品/**`、`projects.json`、真实正文、档案、记忆和回收站内容。
- `.env*`、Token、API Key、Cookie、浏览器数据和 Provider 账户配置。
- 不相关功能、UI 视觉重设计、数据库/微服务/Kafka/Kubernetes/CQRS/Event Sourcing。
- 不删除远端仓库、分支、标签或改变可见性/权限。
- 不调用真实 DeepSeek/Codex 生成，不做真实计费验证。

## 已确定实现要求

1. P0.1：只从全部 Git 分支/标签历史移除 `Novel-Codex-Writer/小说项目/projects.json` 和已确认私人作品目录；保留占位文件、模板、当前工作树与忽略的本地资产。先用独立镜像改写和验证，再更新远端引用；记录受影响 PR/fork/缓存的外部残余边界。
2. P0.2：正文、history、projects registry、Memory transaction 使用按目标串行化或跨进程锁；revision/hash 在提交前重检；临时文件名不可碰撞。
3. P1.1：AI 解析、verification、stored run 和 finalization 统一 runtime schema；异常、缺来源、stale、未验证必须 blocked/unverified。
4. P1.2：所有递归 walk/read/write/export/index 路径统一 canonical 边界，拒绝 junction/symlink 越界。
5. P1.3：AI 请求绑定磁盘 revision 或显式草稿 revision；稳定错误码、secret redaction、输出上限、in-flight/idempotency 和取消传播。
6. P1.4：显式工作流状态表；非 active 作品始终传 project root；Python 子进程有 timeout/cancel/per-project gate。
7. P1.5：CI 运行 37 个 Python 测试、44 个 Vitest、TypeScript/Vite build，并生成可导入的覆盖率和依赖审计产物。
8. P2.1-P2.3：按 route/service/provider/error、前端 lifecycle/request controller、Python registry/patch/index/transaction/diagnostics seam 渐进拆分；保持 URL、payload、Markdown、CLI 和 Provider 语义。
9. P2.4：记录扫描文件/字节、上下文字符、Provider 次数/耗时、导出和 bundle 预算；有证据后再缓存/流式化。
10. P2.5：先修 PostCSS/nanoid；大版本升级单独验证，不能以破坏当前行为换取“最新版”。
11. P3.1：只有仓库调用、测试和真实格式盘点证明无用后才删除；必要 legacy adapter 保留并明确淘汰条件。

## 验收标准

- 每个编号都有对应代码/历史变更和直接测试证据，或有证据证明候选不应删除/升级而被保留。
- 并发写只有一个成功，竞争者明确 `409`/blocked；无丢稿和旧备份覆盖。
- symlink/junction 外部哨兵经真实入口全部被拒绝。
- malformed AI、无 source verification、损坏 stored run、stale manifest 均不能 pass/finalize。
- Provider 错误/日志/HTTP 不含 key、token、bearer、authorization；重复请求不会重复调用。
- workflow timeout、取消、非 active project 和重复动作有直接测试。
- 根 Python、子项目 Python、Vitest、build、CI 配置、coverage、npm audit、Codemap、SonarQube 全部复核。
- `git status --short`、`git diff --stat`、敏感信息扫描、小说资产路径状态和远端 ahead/behind 均核对。
- P0.1 后全部可写分支/标签不再包含目标路径；明确记录 GitHub PR/fork/cache 不能仅靠 force-push 消除的外部边界。

## 基线与最终测试命令

```powershell
python -m compileall -q .
python -m unittest discover -s tests -p "test_*.py" -v
Set-Location Novel-Codex-Writer
python -m unittest discover -s tests -p "test_*.py" -v
Set-Location frontend
npm test
npm run build
npm audit --audit-level=high --json
```

新增测试应优先使用隔离临时目录、假 Provider 和受控子进程，不读取或改写真实小说数据。

## 返回格式

每个阶段返回：完成的编号、修改文件、关键行为、测试命令与结果、迁移/回滚说明、未解决外部边界。最终返回完整 P0.1-P3.1 验收矩阵、Git 分支/提交/远端结果、Codemap 与 SonarQube 前后对比。
