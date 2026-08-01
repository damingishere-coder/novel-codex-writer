# Novel Codex Workbench

本目录是 `Novel-Codex-Writer` 的本地网页工作台，用来管理多本小说：

- 创建、切换、重命名、删除小说项目。
- 查看、搜索、编辑当前小说的 Markdown 文件。
- 将删除的小说或文档移动到 `小说项目/.trash/`，避免误删后无法找回。
- 使用 DeepSeek V4 快速审校，或复用本机 Codex 登录进行深度审校。

页面参考 shadcn-admin 的本地工作台思路：左侧导航、中间阅读和编辑、右侧速览、全局搜索、深色模式和响应式布局。

## 一键启动方式（推荐）

本项目已经接入 Docker。平时不需要手动输入 `npm install` 或 `npm run dev`。

在 `Novel-Codex-Writer` 项目根目录里双击：

- `启动网页.bat`：启动网页，并自动打开 `http://localhost:5173/`
- `关闭网页.bat`：关闭网页服务

启动后，Docker Desktop 的 Containers 页面会出现 `novel-codex-workbench`。

也可以使用英文脚本名：

- `start-web.bat`：启动网页
- `stop-web.bat`：关闭网页服务

如果 Docker Desktop 没有打开，`start-web.bat` 会尝试自动打开它并等待。第一次启动会自动下载 Node 镜像并安装前端依赖，可能需要几分钟。之后再启动会快很多。

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

API 会限制读写范围，不能访问当前小说目录之外的文件。
