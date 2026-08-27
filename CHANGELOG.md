# Changelog

本项目的重要变化记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## Unreleased

### Added

- 写作驾驶舱与 `WorkflowStatus` schema v2，为每个阶段提供结构化唯一下一步。
- 脱敏启动预检、只读连续性浏览器和 ZIP 三段式安全新项目导入。
- 根目录 Windows 原生启动/关闭转发入口与真实连续 10 章验收清单。

### Changed

- Windows 原生 `127.0.0.1:5174` 成为唯一推荐启动方式，Docker `127.0.0.1:5173` 保留为高级备用。
- 工作台启动和切换作品后默认展示创作进度；次要诊断收进高级操作。
- 唯一作品事实源明确为 `Novel-Codex-Writer/小说项目/`，移除根目录空重复占位。

### Fixed

- 重复应用相同 memory patch 时仅在索引缺失或过期时重建，避免健康索引只因时间戳变化被改写。
- Windows 501 文件扫描边界测试使用单用例 20 秒超时，保持原边界断言不变。

## 0.1.0 - 2026-08-03

### Added

- 本地多作品小说工作台。
- 小说创建、切换、重命名、编辑、搜索和回收站能力。
- Codex `webnovel-writer` Skill 与章节辅助脚本。
- 章节细纲、写作任务书、章节检查、章节提交和 memory patch 工作流。
- `current` 当前状态投影、可重建索引、历史档案和篇章摘要机制。
- DeepSeek 快速审校与 Codex 深度审校入口。
- 中英文项目主页、快速开始、写作工作流、项目结构和排错文档。
- MIT License、贡献指南、安全说明、路线图与 GitHub Issue / PR 模板。
- 三张产品预览占位图。
- 完全虚构的《雾港来信》脱敏 Demo，覆盖大纲、正文、审查、章节提交、memory patch 和 current 投影。
- GitHub Actions CI、仓库安全测试、Demo schema 测试、章节检查器烟雾测试和记忆系统功能测试。
- `docs/releases/v0.1.0.md` 正式发布说明。

### Changed

- 重构中文 README，使首页从内部开发说明转为面向作者、Agent 用户和贡献者的产品入口。
- 将章节流程、记忆机制和目录说明拆分到 `docs/`，降低首页阅读负担。
- 仓库名称统一为 `novel-codex-writer`，并更新中英文文档中的克隆地址。
- `小说项目/projects.json`、用户作品目录和回收站默认被 Git 忽略，降低私密正文误提交风险。
- CI 使用只读仓库权限，并在每个 PR 与 `main` 推送上自动运行。

### Fixed

- 限制 `activeProjectId` 只能解析到 `小说项目/作品/` 内，阻止通过 `../` 跳出作品目录。
- 为 memory patch 重复 ID、非法状态、索引重建、索引恢复和幂等执行增加回归测试。
- 同一 `patch_id` 对应不同内容时必须失败，避免静默覆盖历史记忆。

### Security

- 默认忽略 `.env`、会话缓存、日志、构建产物和用户真实小说数据。
- 增加自动化检查，阻止密钥样式文件和个人作品进入公共仓库。
- 增加活动作品路径逃逸测试。

> 创建 GitHub 标签和 Release 后，将 `docs/releases/v0.1.0.md` 作为 Release 正文。
