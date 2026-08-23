# Novel Codex Workbench

本目录是 `Novel-Codex-Writer` 的本地网页工作台，用来管理多本小说：

- 创建、切换、重命名、删除小说项目。
- 查看、搜索、编辑当前小说的 Markdown 文件。
- 将删除的小说或文档移动到 `小说项目/.trash/`，避免误删后无法找回。
- 查看创作进度、文档历史和差异，恢复版本或回收站文件，导出整书 Markdown/ZIP。
- 使用固定的 DeepSeek V4-Flash 模型快速审校，或复用本机 Codex 登录进行深度审校。

页面参考 shadcn-admin 的本地工作台思路：左侧导航、中间阅读和编辑、右侧速览、全局搜索、深色模式和响应式布局。

## 一键启动方式（推荐）

默认使用 Windows 本机 Node/Vite 启动，不依赖 Docker。平时不需要手动输入 `npm install` 或 `npm run dev`。

在 `Novel-Codex-Writer` 项目根目录里双击：

- `启动网页.bat`：启动网页，并自动打开 `http://127.0.0.1:5174/`
- `关闭网页.bat`：关闭网页服务

也可以使用英文脚本名：

- `start-web.bat`：启动网页
- `stop-web.bat`：关闭网页服务

第一次启动缺少依赖时会自动安装，PID 和日志写入 Git 忽略的 `.runtime/`。需要 Docker 回退时使用项目根目录的 `start-docker.bat` 和 `stop-docker.bat`。

如果页面刚打开时还在加载，等待 10-20 秒后刷新即可。

## 手动启动方式（备用）

在这个目录执行：

```powershell
npm install
npm run dev
```

成功后终端会出现类似：

```text
Local: http://127.0.0.1:5173/
```

打开这个网址即可查看本地小说工作台。

## 构建检查

```powershell
npm run build
```

如果构建成功，会生成 `dist/` 目录。

## API

- `GET /api/projects`：读取作品库清单。
- `POST /api/projects`：创建新小说。
- `PATCH /api/projects/:id`：重命名或切换当前小说。
- `DELETE /api/projects/:id`：把小说移入 `.trash/`。
- `GET /api/library?projectId=...`：扫描当前小说的 Markdown 文件。
- `GET /api/document?projectId=...&path=...`：读取单个 Markdown 文件。
- `PUT /api/document?projectId=...&path=...`：保存 Markdown 文件。
- `DELETE /api/document?projectId=...&path=...`：把 Markdown 文件移入 `.trash/`。
- `GET /api/search?projectId=...&q=...`：搜索当前小说标题、路径和正文内容。
- `GET /api/ai/status`：只返回 AI 是否可用，不返回密钥。
- `PATCH /api/ai/settings`：保存模型、默认引擎和本机 DeepSeek 密钥。
- `GET /api/workflow/status`、`POST /api/workflow/actions`：创作进度与安全工作流动作。
- `GET/POST /api/versions`：历史版本、差异和带 revision 冲突保护的恢复。
- `GET/POST /api/trash`：回收站列表和无覆盖恢复。
- `POST /api/export?type=markdown|zip`：整书 Markdown 与当前作品完整 ZIP 备份。

API 仅允许本机 Host/Origin，限制 2 MiB 请求体；文档和批注保存要求 `expectedRevision`，并拒绝路径穿越、符号链接逃逸和静默覆盖。
