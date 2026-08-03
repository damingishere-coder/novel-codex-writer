# 常见问题与排错

## 网页没有自动打开

手动访问：

```text
http://localhost:5173/
```

如果仍无法访问：

1. 确认 Docker Desktop 已启动。
2. 检查项目容器是否正在运行。
3. 关闭后重新双击 `启动网页.bat`。
4. 检查 5173 端口是否被其他程序占用。
5. 查看容器日志，但提交 Issue 前先删除密钥和个人路径。

## 第一次启动很慢

第一次启动通常需要下载镜像、安装依赖和构建服务，速度取决于网络和电脑性能。

不要在构建过程中反复点击启动脚本。先观察 Docker Desktop 中的容器和构建状态。

## Docker Desktop 未启动

常见表现：

- 启动脚本一闪而过
- 无法连接 Docker daemon
- 浏览器打开但页面无法访问

处理方式：

1. 手动打开 Docker Desktop。
2. 等待 Docker 完成初始化。
3. 再运行启动脚本。

## 5173 端口被占用

使用 PowerShell 检查：

```powershell
netstat -ano | findstr :5173
```

找到占用程序后，先确认它是否可以关闭。不要直接结束不认识的系统进程。

若需要调整项目端口，应同步修改启动配置和文档。

## 新建或保存文档失败

检查：

- 项目是否位于有读写权限的目录
- 文件路径是否包含异常字符
- 当前小说是否仍然存在
- `projects.json` 中是否有有效活动项目
- Docker 挂载目录是否正确
- 文件是否被其他编辑器独占

项目不应允许文档路径跳出当前作品目录。

## Codex 找不到当前小说

先确认网页中已经选择一本活动小说，然后检查：

```text
小说项目/projects.json
```

Codex 应读取其中的 `activeProjectId`。没有活动小说时应停止，不应自行选择其他作品。

## Codex 找不到 webnovel-writer Skill

检查仓库内是否存在：

```text
.agents/skills/webnovel-writer/
```

并确认你是在仓库根目录打开 Codex。

如果使用不同 Agent 平台，其 Skill 发现规则可能不同，需要按照该平台的 Skill 安装方式配置。

## 无法生成写作任务书

最常见原因是对应章节细纲不存在。

例如第 1 章需要：

```text
大纲/细纲_第001章.md
```

先让 Codex 生成细纲并由作者确认，再运行 `build_context.py`。

## 章节检查失败

检查：

- 正文文件名和章节号是否匹配
- 正文字数是否符合当前项目规则
- 是否出现工程词泄漏
- 前置章节是否缺失
- 是否读取了旧备份而不是正式正文

S1 和 S2 问题应先处理，再生成章节提交和 memory patch。

## memory patch 无法应用

始终先运行：

```powershell
python .agents\skills\webnovel-writer\scripts\update_memory.py --patch <补丁文件> --dry-run
```

常见原因：

- patch JSON 格式错误
- 缺少 `patch_id`
- 章节号不一致
- 操作引用了不存在的稳定 ID
- 相同 patch ID 已使用但内容不同
- current 中存在无法安全识别的旧格式条目

不要为了绕过报错直接手工批量修改 current。先修复补丁或执行迁移诊断。

## DeepSeek 显示未配置

1. 在网页左下角打开 AI 设置。
2. 重新保存 API Key。
3. 确认本机 `.env` 已写入，但不要把内容贴到 Issue。
4. 确认选择的模型在账户中可用。
5. 重启本地服务后再次检查。

如果怀疑密钥已经泄漏，应立即撤销旧密钥并创建新密钥。

## Codex 深度审校不可用

检查：

- 本机 Codex App 或 CLI 是否已登录
- 本地 Codex 是否能够单独正常运行
- 启动脚本是否有权读取并复制必要的本机会话
- 会话文件是否被安全软件阻止访问

不要把 Codex 会话文件复制到仓库或上传到 Issue。

## AI 没配置，网页还能用吗

可以。以下功能应保持可用：

- 阅读 Markdown
- 新建与编辑文档
- 保存文档
- 搜索
- 批注
- 管理作品

AI 只是可选增强能力。

## 删除的小说或文档去哪了

网页删除操作通常会移动到：

```text
小说项目/.trash/
```

不要把回收站内容当成当前小说资料。如果需要恢复，先备份当前作品，再谨慎移动文件。

## 如何提交有效的 Bug 报告

请提供：

- 操作系统版本
- Docker Desktop 版本
- 使用的仓库提交或版本
- 复现步骤
- 预期结果和实际结果
- 脱敏后的错误信息

不要提供：

- API Key
- Cookie 或 Token
- `.env` 全文
- Codex 登录缓存
- 未公开小说全文

更多要求见 [CONTRIBUTING.md](../CONTRIBUTING.md) 和 [SECURITY.md](../SECURITY.md)。
