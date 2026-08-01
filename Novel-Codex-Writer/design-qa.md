# Design QA：苹果风 AI 小说审校工作台

- source visual truth path: `C:\Users\10578\.codex\generated_images\019f7f63-7df4-7aa0-87a6-6cb43cb3151b\exec-20f73e18-9ef2-47de-9242-aa7472d5804c.png`
- implementation URL: `http://127.0.0.1:5173/`
- implementation screenshot path: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-implementation.png`
- full-view comparison path: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-comparison.png`
- focused comparison path: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-focused.png`
- viewport: implementation `1280 × 720`；source mock `1488 × 1058`。内置浏览器视口固定，因此比较以区域比例、层级和密度为主，不做虚假的逐像素结论。
- state: 浅色模式；左栏展开且仅当前分组展开；中间审校只读模式；右栏展示一条待确认建议和一条已采用建议；AI 使用本地模拟展示数据，截图后已清理。

## Full-view comparison evidence

- 信息架构一致：顶部工具栏、资料目录、正文行号区、AI 审校栏按同一顺序与层级呈现。
- 关键区域比例一致：左栏约 21%，右栏在 1280px 响应式宽度下为 342px；更宽视口会回到 370px。中间文档保持最宽、可滚动。
- 方案中的蓝色选中态、白/浅灰表面、细分隔线、8–10px 圆角和轻阴影均已映射为统一 CSS 变量。
- 实现截图使用当前真实资料，因此正文内容与 mock 的示例章节不同；这是数据差异，不是布局漂移。

## Focused region comparison evidence

- 右侧批注卡均有“原文 / 建议改为 / 修改说明”三层信息，以及采用、忽略、重新生成动作。
- 待确认使用蓝色边框，已采用使用绿色语义色；图标来自 Lucide 图标库，没有用文本符号、CSS 图形或手绘 SVG 替代。
- 1280px 下卡片因右栏从 mock 的约 390px 压缩到 342px，正文换行略多，但按钮、标题和状态均未重叠或裁切，属于预期响应式差异。

## Required fidelity surfaces

- Fonts and typography: UI 使用 Apple 系统字体栈与中文系统无衬线；正文使用宋体/思源宋体回退。字号、字重、行高和截断层级清晰，CodeMirror 行高为 1.9，长文件名会省略而不挤压工具栏。
- Spacing and layout rhythm: 68px 工具栏、54px 文档栏、三栏网格、侧栏分组和批注卡间距稳定；1280px 无横向溢出，左右栏可独立隐藏。
- Colors and visual tokens: 浅灰工作台、白色表面、蓝色主操作、绿色已采用、琥珀过期/错误、红色回收站操作均有一致语义；深色模式使用对应 token。
- Image quality and asset fidelity: 目标是纯产品 UI，没有照片、插画或品牌图像资产；所有可见图标使用同一 Lucide 图标库，缩放清晰。
- Copy and content: “移到回收站”“采用只更新草稿”“配置密钥”等文字明确说明可恢复性和保存边界；不展示模型内部思维链。

## Findings

- 没有剩余 P0、P1 或 P2 问题。
- [P3] 生产包目前约 826 kB，后续可将 CodeMirror 和 AI 设置弹窗按需加载；这不影响本轮视觉、交互或可用性。

## Comparison history

1. Earlier finding [P2]：CRLF 文档经 CodeMirror 规范化后，刚打开就错误显示“未保存”。
   - Fix：草稿脏状态比较前统一换行符，只在正文实际变化时显示未保存。
   - Post-fix evidence：`design-qa-implementation.png` 顶部明确显示“已保存”，实时字数仍为 241 字。
2. Earlier finding [P2]：测试批注快速保存与删除时，旧请求返回可能把已删除批注写回界面。
   - Fix：批注自动保存不再用旧响应覆盖当前 React 状态，并增加显式删除批注按钮。
   - Post-fix evidence：浏览器删除后卡片数为 0，随后接口读取 `annotationCount: 0`。

## Primary interactions tested

- 作品管理弹窗只显示真实存在的小说；幽灵小说“门”已清理。
- 目录分组展开/收起、左栏整体折叠/恢复。
- 点击行号创建单行批注；Shift + 点击形成连续多行批注。
- 输入批注、选择 GPT/Codex；未配置密钥时单卡显示明确错误，不影响编辑。
- 删除测试批注、刷新恢复会话、右栏隐藏/恢复、浅色/深色切换。
- 文档 revision 长度 64；错误 expectedRevision 返回 409；路径越界返回 403；AI 状态不含密钥字段。
- 浏览器未出现 Vite error overlay；上述主交互与 API 请求均完成，无运行时中断。

## Implementation checklist

- [x] 苹果风三栏布局与响应式侧栏
- [x] CodeMirror 行号、审校/编辑/预览模式
- [x] 实时字数与章节目标状态
- [x] 批注卡、持久化、采用冲突保护与导出
- [x] GPT/Codex 状态、设置与统一流式接口
- [x] 安全回收站、幽灵索引清理、版本冲突与路径边界
- [x] 单元测试、生产构建和浏览器验收

final result: passed

---

# Design QA：AI 审阅可读性与可拖拽分栏改造（2026-07-23）

- source visual truth path: `C:\Users\10578\AppData\Local\Temp\codex-clipboard-d9807335-452e-4d37-9026-6dea6e19775e.png`
- implementation URL: `http://127.0.0.1:5173/`
- 1440 × 900 dark screenshot: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-resizable-review-dark-1440.png`
- 1440 × 900 light screenshot: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-resizable-review-1440.png`
- 1366 × 768 screenshot: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-resizable-review-1366.png`
- 1024 × 768 screenshot: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-resizable-review-1024.png`
- 390 × 844 screenshot: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-resizable-review-mobile-390.png`
- focused implementation path: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-resizable-review-focused.png`
- full-view comparison path: `C:\Users\10578\Documents\webnovel-writer Skill\Novel-Codex-Writer\design-qa-resizable-review-comparison.png`
- state: 深色模式；左侧资料库与右侧 AI 审阅均展开；审阅栏显示整章体检后的 7 条问题；宽度先复位为默认值，再进行对比截图。
- density normalization: 原始参考图为 `565 × 1767`；实现侧从 `1440 × 1568`、设备像素比 1 的真实浏览器截图中裁出 `480 × 1500` 的审阅栏区域，再仅为并排比较统一缩放到 `565 × 1767`。尺寸数据与文字可读性结论均以缩放前浏览器计算值为准。

## Full-view comparison evidence

- 参考图中的审阅栏约 370px，长句换行频繁且卡片密集；实现默认宽度为 480px，正文区域仍保留 634px，左右之间各有 8px 可见拖拽条。
- 1440 × 900 下三栏实测为左栏 310px、正文 634px、审阅栏 480px；1366 × 768 下为 310px、560px、480px，两个尺寸均无水平溢出。
- 1024 × 768 下继续使用覆盖式侧栏：正文保留 966px 可用区域，右侧审阅栏为 480px；390 × 844 下审阅栏全屏 390px，拖拽条隐藏，无水平溢出。
- 左右栏折叠后，已保存宽度不会丢失；重新展开时恢复原宽度，正文自动重新占用剩余空间。

## Focused region comparison evidence

- 问题标题浏览器计算值为 14px；证据、影响、修法正文为 13px，行高 22.75px（约 1.75），相较参考图减少拥挤并提高连续阅读清晰度。
- 审阅卡内边距增至 16px，卡片之间的纵向节奏拉开；摘要、筛选、资料来源与批注卡同步提高文字对比度和字号。
- 类别与状态信息在窄宽度下自动换行，不再挤压标题；资料路径允许断行，普通中文审阅正文维持自然换行。
- 颜色、圆角、描边、Lucide 图标与原有暗色工作台保持一致，没有引入新视觉语言或替换图标库。

## Required fidelity surfaces

- Fonts and typography: 继续使用项目现有系统字体栈；审阅标题、正文、辅助文字按信息层级分别设定 14px、13px 和 11–12px，正文行高约 1.7–1.75。
- Spacing and layout rhythm: 左栏默认 310px、审阅栏默认 480px，拖拽范围分别为 220–420px 与 400–680px；宽屏正文保底 480px，拖到边界即停止。
- Colors and visual tokens: 沿用已有深色/浅色 token、蓝色主操作、严重级别语义色及状态色；卡片对比度增强但未偏离原设计。
- Image quality and asset fidelity: 本次为纯产品 UI 改造，不需要新增图片资产；所有可见图标继续来自现有 Lucide 图标库。
- Copy and content: 没有修改小说正文、审阅结果、模型逻辑或接口数据；现有采用、标记不适用、导出、筛选、定位原文和整章体检行为均保留。

## Findings

- 没有剩余 P0、P1 或 P2 问题。
- [P3] 生产构建仍有原有的单包体积大于 500kB 提示；它不影响本次布局、交互和可读性验收。

## Comparison history

1. 初始参考图显示右侧栏过窄、正文换行密集，且工作区没有可调整宽度的分隔控件。
   - Fix：加入左右两个可见分隔条，并把审阅栏默认值提升到 480px；同时提高审阅文字尺寸、行高、内边距和卡片间距。
   - Post-fix evidence：`design-qa-resizable-review-comparison.png` 显示相同审阅内容在更宽栏位中层级更清晰；浏览器计算值与多视口截图确认正文不会被挤没。
2. 响应式复查未发现新的遮挡、裁切或水平溢出问题，因此无需第二轮视觉修正。

## Primary interactions tested

- 右侧分隔条鼠标拖动：审阅栏由 480px 调整到 508px；左侧分隔条鼠标拖动：资料库由 310px 调整到 356px。
- 分隔条键盘调整：聚焦后使用方向键可按 16px 微调；`Home` 与双击均可恢复默认宽度。
- 刷新后宽度保持为 356px / 508px；双击复位后回到 310px / 480px。
- 折叠两侧栏时分隔条同步消失；重新展开后分隔条与保存宽度正确恢复。
- 1440 × 900、1366 × 768、1024 × 768 与 390 × 844 均完成滚动、布局和文字可读性检查。
- 浏览器控制台 `error` 与 `warn` 均为 0，未出现 Vite 错误遮罩或运行时中断。
- 单元测试共 35 项全部通过；生产构建成功，仅保留原有大包体积警告。

## Implementation checklist

- [x] 左右分隔条的鼠标拖动、键盘调整、双击复位及 `separator` 无障碍语义
- [x] 两栏宽度范围限制、正文 480px 保底及中等窗口可调整覆盖式布局
- [x] `novel-left-pane-width` 与 `novel-review-pane-width` 持久化及非法值回退
- [x] 审阅标题、正文、行高、对比度、卡片间距和窄宽度换行优化
- [x] 四种目标视口、折叠恢复、刷新保留、控制台、单元测试和生产构建验收

final result: passed
