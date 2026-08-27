# 快速开始

本文档用于完成第一次本地启动、创建小说和启用可选 AI 能力。

## 1. 准备环境

建议环境：

- Windows 10 或 Windows 11
- Node.js 20+ 与 npm
- Python 3.10+
- 至少预留 1 GB 磁盘空间用于依赖、版本和备份
- 可选：Git
- 可选：Codex App / Codex CLI
- 可选：DeepSeek API Key
- 可选：Docker Desktop（备用启动方式）

Windows 原生模式不要求 Docker Desktop。

## 2. 下载项目

### 使用 Git

```powershell
git clone https://github.com/damingishere-coder/novel-codex-writer.git
cd novel-codex-writer
```

### 使用 ZIP

1. 打开 GitHub 仓库主页。
2. 点击 **Code → Download ZIP**。
3. 解压到路径较短、具有读写权限的目录。
4. 不建议放在系统受保护目录中。

### 先浏览脱敏 Demo

仓库中的 [`examples/demo-novel/`](../examples/demo-novel/) 是一套完全虚构的示例，展示原始大纲、章节细纲、缩短版正文、审查报告、章节提交、memory patch 和 `current` 状态如何对应。

Demo 不会自动写入你的作品库。真实作品唯一保存在本机 `Novel-Codex-Writer/小说项目/作品/`，对应 `projects.json`、`作品/` 和 `.trash/` 默认被 Git 忽略。

## 3. 启动网页工作台

在项目目录中双击：

- `启动网页.bat`：转发到程序目录，启动 Windows 原生服务并打开网页。
- `关闭网页.bat`：停止本地服务。

默认访问地址：

```text
http://127.0.0.1:5174/
```

首次启动会在 `Novel-Codex-Writer/frontend/` 安装依赖。浏览器打开后可点“启动预检”，确认 Node/npm、Python、端口、作品库、注册表、活动作品和未完成事务。AI 不可用只影响 AI 审校，不会阻止普通阅读和编辑。

需要 Docker 备用模式时，运行 `Novel-Codex-Writer/start-docker.bat`，访问 `http://127.0.0.1:5173/`。

## 4. 创建第一本小说

作品库为空时，网页会显示“新建小说”入口。

1. 输入小说名称。
2. 创建作品。
3. 在文档树中新建：

```text
大纲/原始大纲.md
```

4. 写入你现有的构想。内容可以粗糙，例如：

```markdown
# 暂定书名

## 核心设定
主角、世界规则、力量体系和故事冲突。

## 主要人物
人物目标、性格、关系和秘密。

## 大致剧情
开局发生什么，中期如何升级，最终冲突是什么。
```

原始大纲不要求一次写完整，它只是后续整理的输入。

## 5. 使用 Codex 初始化作品

在 Codex App 或 Codex CLI 中打开仓库根目录，输入：

```text
请使用 webnovel-writer Skill，读取当前小说的大纲/原始大纲.md。
先不要写正文，请整理总纲、篇纲和章节规划，并初始化 current 投影与索引。
```

Codex 应先读取：

```text
Novel-Codex-Writer/小说项目/projects.json
```

确认当前活动小说，只能在对应作品目录内操作。

## 6. 开始第 1 章

建议先让 Codex 生成或整理章节细纲，再开始正文：

```text
请使用 webnovel-writer Skill，开始写第 1 章。
先确认本章细纲并生成写作任务书，再写正文；完成审查和修改后保存正文，并生成章节提交与 memory patch。
```

章节细纲路径格式：

```text
大纲/细纲_第001章.md
```

正式正文路径格式：

```text
正文/第001章_标题.md
```

## 7. 配置 DeepSeek（可选）

DeepSeek 用于网页中的快速审校，不配置也不影响普通阅读和编辑。

1. 打开网页左下角的 **AI 设置**。
2. 在 DeepSeek API Key 输入框中粘贴密钥。
3. 选择可用模型。
4. 保存设置。

项目也可能提供 `配置AI密钥.bat` 作为备用配置方式。

真实密钥应只保存在本机 `.env`。不要截图、上传或提交 `.env`。

## 8. 使用 Codex 深度审校（可选）

Codex 不需要在项目中单独保存 API Key。启动流程会尝试使用本机 Codex App / CLI 已有的登录状态。

审校结果应遵循以下原则：

- 每条建议显示原文、修改建议和原因。
- “采用”只修改当前草稿。
- 必须再次点击保存，才会写入正式正文。
- AI 建议不是强制修改，作者保留最终决定权。

## 9. 验证是否启动成功

首次体验成功应满足：

- 浏览器可以打开 `http://127.0.0.1:5174/`。
- 顶部“下一章写作驾驶舱”在 10 秒内说明当前章节、六步进度、阻断原因和唯一下一步。
- 可以创建和切换小说。
- 可以新建、编辑和保存 Markdown 文档。
- 关闭并重新启动后，已保存内容仍然存在。
- 没有配置 AI 时，普通编辑功能仍可使用。
- ZIP 导入必须先预检，再由作者确认，并创建新的项目 ID。

## 10. 下一步

- 浏览 [脱敏 Demo](../examples/demo-novel/)。
- 阅读 [完整写作工作流](writing-workflow.md)。
- 了解 [项目目录与数据说明](project-structure.md)。
- 遇到问题查看 [常见问题与排错](troubleshooting.md)。
- 开始真实连续试写前打印或复制 [10 章验收清单](ten-chapter-acceptance.md)。
