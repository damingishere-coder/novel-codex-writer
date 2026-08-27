# Novel Codex Writer 系统式作者闭环升级任务

## 背景

项目已完成 P0.1-P3.1 工程整改，但标准测试存在两处不稳定，仓库根入口与实际运行目录不一致，工作流的“唯一下一步”藏在次级面板中，结构化记忆缺少只读浏览入口，完整 ZIP 备份尚不能安全导入。

## 目标

- 恢复两组 Python、Vitest 和生产构建全绿。
- 固定 Windows 原生启动与唯一作品库事实源。
- 增加本机启动预检、WorkflowStatus schema v2 和写作驾驶舱。
- 增加只读连续性浏览器与项目一致性诊断。
- 增加完整 ZIP 的预检、作者确认、创建新项目三段式安全导入。
- 为真实连续 10 章保留人工验收门禁，不读取或修改私人作品来伪造结果。

## 允许修改范围

- 根启动/关闭脚本、根 README/quick-start/ROADMAP/.gitignore 和空的根 `小说项目` 占位。
- `frontend/shared`、`frontend/server`、`frontend/src`、对应 Vitest/Playwright 测试。
- webnovel-writer Skill 的记忆索引幂等实现及对应测试。
- 本任务文件与必要发布说明。

## 禁止修改范围

- `Novel-Codex-Writer/小说项目/projects.json`、真实作品、回收站和本机 AI 设置。
- 任何密钥、Token、Cookie、Codex 登录状态、`.env` 内容或绝对私人路径。
- SaaS、远程协作、多模型扩张、数据库、桌面封装和无人值守批量写作。
- 自动覆盖正文、自动应用 memory patch、导入覆盖已有项目。

## 已确定实现要求

- 根目录只作仓库/文档入口；程序与作品事实源保留在 `Novel-Codex-Writer/`。
- 原生入口固定 `127.0.0.1:5174`；Docker `127.0.0.1:5173` 仅为备用。
- Preflight 不返回绝对路径、正文或凭据；AI 不可用只能是非阻断降级。
- WorkflowStatus schema v2 新增结构化 `nextStep`，旧推荐字段保留一个版本。
- 页面任意时刻只有一个工作流主操作；危险动作仍需作者确认。
- Memory Overview 只读消费既有索引，校验 source hash、路径边界和预算，不建立第二事实源。
- ZIP 导入仅接受本项目导出的 stored ZIP；限制 64 MiB、5000 文件，拒绝加密、压缩、路径穿越、重复项、符号链接、非法 metadata 和覆盖导入。
- 自动测试全部使用临时目录和假 Provider。

## 验收标准

- 根 Python 30/30、项目 Python 52/52、Vitest 全部通过、TypeScript/Vite build 通过。
- 工作流每种 nextStep 有契约测试，UI 只渲染一个主按钮。
- Preflight 能区分阻断、警告和正常状态，不泄露路径。
- 连续性浏览器支持分类、状态、实体和标签筛选，并能打开来源 Markdown。
- ZIP 预检后必须再次确认，导入后生成新 ID，原项目不变。
- `git diff` 不包含真实作品、密钥、运行日志、构建或测试临时产物。

## 测试命令

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
python -m unittest discover -s Novel-Codex-Writer/tests -p "test_*.py" -v
Set-Location Novel-Codex-Writer/frontend
npm test
npm run build
npm run e2e
```

## 返回格式

- 汇总实际完成的用户可见行为、接口和安全边界。
- 报告所有测试命令、数量、失败/限制。
- 明确真实 10 章仍是人工验收，不把自动 fixture 冒充真实创作。
- 报告 Git 提交、分支、远端和推送结果。
