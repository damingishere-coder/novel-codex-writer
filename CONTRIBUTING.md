# Contributing to Novel Codex Writer

感谢你愿意改进这个项目。我们欢迎 Bug 修复、文档完善、工作流建议、测试补充和功能贡献。

## 开始之前

本项目会直接读写小说正文、设定与长期记忆。任何涉及数据结构、文件路径或自动修改正文的变更，都应优先保证：

1. 不跨小说读取或写入资料。
2. 不覆盖作者尚未确认的正文。
3. 不把索引当成唯一事实源。
4. 不破坏旧项目的可迁移性。
5. 不在日志、测试数据或提交记录中泄漏密钥和私密正文。

重大变更请先创建 Issue 说明使用场景和兼容方案。

## 提交 Issue

### Bug 报告

请尽量包含：

- 操作系统与 Docker Desktop 版本
- 使用的分支或版本
- 可复现步骤
- 预期结果与实际结果
- 脱敏后的错误信息或日志
- 是否涉及 Codex、DeepSeek 或纯本地编辑

不要提交真实 API Key、登录缓存、个人信息或未公开小说全文。

### 功能建议

请从具体创作场景出发说明：

- 谁会使用这个功能
- 当前流程有什么困难
- 希望得到什么结果
- 是否会改变小说项目目录或记忆格式

## 本地开发

### 基本要求

- Windows 10 / 11
- Docker Desktop
- Git
- 根据修改范围，可能还需要 Node.js、Python 和 Codex CLI

### 建议流程

```powershell
git clone https://github.com/damingishere-coder/novel-codex-writer.git
cd novel-codex-writer
git checkout -b feat/your-change
```

启动方式与项目现有使用方式一致，详见 [docs/quick-start.md](docs/quick-start.md)。

## 分支与提交

建议使用清晰的分支名：

```text
feat/feature-name
fix/bug-name
docs/topic
refactor/module-name
```

建议使用简洁的提交前缀：

```text
feat: add chapter history view
fix: prevent cross-project document access
docs: improve DeepSeek setup guide
test: cover memory patch validation
```

## 代码与文档原则

- 优先写清楚的代码和错误信息，不追求过度抽象。
- 自动化脚本执行危险写入前，应支持检查或 dry-run。
- 新增配置时同步更新 `.env.example`，绝不提交真实 `.env`。
- 修改用户工作流时同步更新 README 或 `docs/`。
- 中英文首页的核心能力与限制应保持一致。
- 不要把临时开发记录、运行日志和测试数据库提交到仓库根目录。
- 真实小说、`projects.json` 和 `.trash` 不得作为测试数据提交；请使用 `examples/demo-novel/` 或新增脱敏 fixture。

## 自动化测试

仓库的 GitHub Actions 会执行：

```powershell
python -m compileall -q .
python -m unittest discover -s tests -p "test_*.py" -v
```

提交 PR 前应在本地执行相同命令。现有测试至少覆盖：

- 个人小说数据和密钥类文件不会被 Git 跟踪。
- 脱敏 Demo 的文件结构和 memory patch schema。
- `check_chapter.py` 的章节号识别、字数统计和基础问题检测。

新增或修改核心逻辑时，请同步增加对应测试，而不是只依赖手动验证。

## 手动验证

除了自动化测试，还应完成与你改动相关的验证：

- 工作台能够正常启动和关闭。
- 项目创建、切换、读取和保存不跨作品。
- 未配置 AI 时，基础编辑能力仍可使用。
- 涉及记忆脚本时，先验证 dry-run，再验证正式应用。
- 涉及章节检查时，覆盖正常输入和错误输入。
- 涉及界面时，提供修改前后截图。

## Pull Request 清单

提交 PR 时请确认：

- [ ] PR 只解决一个明确问题
- [ ] 已说明为什么需要这项变更
- [ ] 已列出主要修改和验证方式
- [ ] 没有提交密钥、会话、私密正文或机器专属文件
- [ ] 没有无说明地改变小说目录或记忆数据格式
- [ ] 对用户可见的变化已更新文档
- [ ] 新增依赖有明确必要性
- [ ] 自动化测试已通过

## License

提交代码即表示你同意将贡献内容按照本仓库的 [MIT License](LICENSE) 发布。
