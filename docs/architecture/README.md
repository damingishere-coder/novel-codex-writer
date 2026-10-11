# 小说工作台与 Humanizer 润色层

交互式架构图规格保存在 [`novel-workbench.json`](novel-workbench.json)。本次成品位于仓库内 `.archify/architecture-novel-humanizer-20261011-154658/novel-humanizer.html`；旧图保留在原目录。

```mermaid
flowchart LR
    A[作者把写作任务交给 Codex] --> B[按细纲写作并完成必要修订]
    B --> C[Humanizer 最终正文润色：一次]
    C --> D[检查字数、连续性与事实]
    D --> E[作者确认并保存最终正文]
    E --> F[生成同版审查、章节提交和记忆补丁]
    F --> G[预检并确认应用记忆]
```

Humanizer 由当前写作代理读取项目内的固定规则执行，属于正文创作后的语言处理层。网页的“复制任务给 Codex”会在创作或修订任务中加入这一步，作者仍需把任务交给 Codex。

处理范围和原稿保护见 [`Humanizer润色.md`](../../Novel-Codex-Writer/.agents/skills/webnovel-writer/references/Humanizer润色.md)。普通保存、只读审查和生成记忆记录不触发润色。润色后必须重新检查，最终审查、提交和补丁绑定最终正文版本。

图表源码链接固定到功能提交 `46e437f5615dede251bd9854a7992f16ad575186`。这是本机已有功能上的接入快照；正式交付 PR 只包含本次 Humanizer 和架构图变更。Humanizer 上游固定到 `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8`，保留 MIT 授权。

安装 Archify 后，在仓库根目录可重新生成并验证：

```powershell
node <Archify安装目录>/bin/archify.mjs finalize architecture docs/architecture/novel-workbench.json .archify/architecture-novel-humanizer-20261011-154658/novel-humanizer.html --repo-root . --quality showcase --json
```

本次通过规格、生成回执、静态检查和真实浏览器检查。没有实际润色私人小说，文学效果仍待下一次写作验证。现有 RunDock 的 `Novel-Writer-Web` 服务处于停止状态，本次保留该状态。
