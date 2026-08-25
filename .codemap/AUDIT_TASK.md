# 项目全面工程体检执行任务

## 背景

用户要求对整个 `webnovel-writer Skill` 仓库执行 Codemap、Code Overhaul 与 SonarQube 联合审计，判断 V1 当前为何能运行、健康程度、隐患及低风险整改顺序。

## 目标

- 建立功能模块级架构地图与独立健康评分。
- 审计架构、业务逻辑、代码质量、数据、稳定性、测试、安全、性能、可观测性、依赖和维护性。
- 运行安全的现有测试、构建、类型检查、覆盖率收集和 SonarQube 静态扫描。
- 交叉验证三方证据，最终生成根目录 `PROJECT_AUDIT.md`。

## 允许修改范围

- `.codemap/**`：Codemap 配置、事实源、生成的架构图和审计过程记录。
- `PROJECT_AUDIT.md`：最终审计报告。
- 测试、构建、覆盖率、Sonar 扫描产生的临时或被忽略产物。

## 禁止修改范围

- 所有生产代码、业务逻辑、测试源码、依赖清单、数据库/小说数据与 Schema。
- `.env`、密钥、Token、Cookie、浏览器数据和其他 secrets。
- 不删除 Dead Code、Legacy Code、依赖、分支或任何用户数据。
- 不执行部署、发布、数据库迁移、Git commit、Git push、PR 创建或远端写入。

## 已确定实现要求

- Codemap 以 `.codemap/modules.json` 为事实源，HTML/MD 只能由官方脚本生成。
- 每个功能模块必须按固定 rubric 独立审计；大模块和高耦合模块不得合并评分。
- SonarQube 使用本机共享实例；不得持久化扫描 Token，不得停止或删除共享数据卷。
- 所有问题必须引用 `file:line` 或明确标注为“工具指标/需动态验证”。
- Dead/Legacy 仅列出；低价值规则问题不得机械升级为整改项。
- 若测试可能触及真实小说库、网络或计费 AI Provider，必须跳过并在报告中说明。

## 验收标准

- `.codemap/modules.json` 覆盖全部一方代码功能模块，扫描无空模块、无未审计模块。
- `.codemap/codemap.html` 与 `.codemap/codemap.md` 可从事实源重复生成。
- Build、测试、类型检查、覆盖率、SonarQube均有准确命令、退出码和结果；缺失能力如实记录。
- `PROJECT_AUDIT.md` 包含用户指定的全部章节、健康分、Sonar 指标、P0-P3、Top 10、删除候选、暂时不要动和分轮次路线图。
- 最终核对 Git 状态与 diff，确认没有生产代码、测试源码、依赖或 secrets 被修改。

## 计划测试命令

- 根目录：`python -m unittest discover -s tests -p "test_*.py" -v`
- 子项目：`python -m unittest discover -s tests -p "test_*.py" -v`
- 前端：`npm test`
- 前端：`npm run build`
- 其他安全命令以仓库现有配置和只读侦察结果为准。

## 返回格式

- 精确命令与退出码。
- 通过/失败/跳过数量与耗时。
- 失败时给出最短可定位错误证据。
- 不把静态扫描、Mock 或测试成功写成真实 AI Provider、真实小说数据或生产环境已验证。
