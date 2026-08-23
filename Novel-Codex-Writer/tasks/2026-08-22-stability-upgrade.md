# Novel-Codex-Writer 稳定实用型升级任务

## 背景

项目已经具备 Markdown 事实源、多作品隔离、结构化记忆补丁和 React/Vite 本地工作台。本次在保留现有本机启动、Docker 回退和 DeepSeek V4-Flash 修改的前提下，补齐数据一致性、恢复能力、可见工作流与工程测试。

## 目标

- 让 dry-run 和只读查询真正不写盘，并把事务恢复改为显式操作。
- 绑定章节正文、审查、提交和记忆补丁的 revision，避免旧产物被误用。
- 提供工作流状态、版本历史、回收站恢复和 Markdown/ZIP 导出。
- 修复前后端锚点、上下文、文件分组和保存一致性问题。
- 保留一个渐进披露的 `webnovel-writer` Skill，并对齐全部规则文档。

## 允许修改范围

- `.agents/skills/webnovel-writer/`
- `frontend/server/`、`frontend/src/`、`frontend/package*.json`
- `tests/`、`README.md`、`frontend/README.md`、`AGENTS.md`
- 为本任务新增的 `tasks/` 文件

## 禁止修改范围

- 不修改 `小说项目/作品/` 中的正文、审查报告、章节提交、记忆库或档案库。
- 不读取或写入 `.env`、认证文件、浏览器数据和任何 secrets。
- 不回退现有未提交的本机启动、Docker 回退与固定 DeepSeek 模型改动。
- 不引入数据库、向量 RAG、Tauri、微服务、多智能体自动写书或新模型供应商。
- 不执行 Git push、commit、历史重写、部署或永久删除。

## 已确定实现要求

- 所有文件写入使用原子替换；正文和批注保存使用 optimistic revision。
- 旧 patch 保持原样，schema v1 可读；schema v2 增加 kind、正文 revision 和来源 revision。
- 同章多个旧 patch 未分类时阻断，不自动猜测或删除。
- `.history` 每份文档保留最近 30 个唯一版本，恢复永不静默覆盖。
- 回收站恢复遇到目标冲突返回 409。
- 工作流只自动运行白名单 Python 动作；需要 AI 写作时仅提供复制提示词。
- API 限制本机 Host/Origin、请求体不超过 2 MiB，并隐藏内部绝对路径。
- DeepSeek 继续固定 `deepseek-v4-flash`，Codex 继续复用本机登录。

## 验收标准

- dry-run 前后文件和事务目录完全不变；显式恢复能检测 hash 冲突。
- 非注册项目和越界 input/output 被拒绝。
- 修改正文后旧审查、提交或 patch 显示 stale，不能最终化。
- 工作台展示六阶段状态和唯一下一步；AI 不可用时阅读编辑仍正常。
- 批注追问不因前后端 hash 不同丢失历史，切换文档不会串写流结果。
- 版本、回收站恢复、整书 Markdown 和 ZIP 备份可用且隔离正确。
- Python、Vitest、构建、Skill 校验和 UI 冒烟验证全部通过。

## 测试命令

```powershell
python -m unittest discover -s tests -p "test_*.py"
Set-Location frontend
npm test
npm run build
python -X utf8 "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py" "..\.agents\skills\webnovel-writer"
```

所有 AI 测试使用 mock，不读取真实密钥或访问外部模型。

## 返回格式

- 汇总实际完成的行为变化。
- 列出测试命令、通过数量和仍存在的基线警告。
- 明确说明未修改小说正文和未覆盖既有工作区改动。
