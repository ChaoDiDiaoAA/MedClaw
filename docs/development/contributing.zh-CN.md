# 开发与贡献

[English](contributing.md) · [文档目录](../README.md)

## 工程与前置条件

当前开发路径使用 Windows x64、Bun `1.4.0` 与 Node.js 24。受控子代理依赖补丁已跟踪，按[使用入门](../guides/getting-started.zh-CN.md)与锁文件配套保留。已有依赖目录不能证明干净安装就绪。

| 目录 | 职责 |
| --- | --- |
| `apps/desktop`、`apps/host` | Electron 边界、受控 Host 与维护 |
| `packages/contracts`、`packages/core` | 共享契约、应用与领域行为 |
| `packages/runtime-pi`、`packages/intent-ollama` | 主 Agent 接入与独立本地意图客户端 |
| `packages/storage`、`packages/logging` | 持久化、迁移与诊断投影 |
| `resources` | 产品 Prompt、Skills、子代理角色与模板、受信扩展 |
| `agent-eval`、`tests` | 独立评测与工程验证 |

修改边界前阅读[系统架构](../architecture/overview.zh-CN.md)和[意图识别](../intent/overview.zh-CN.md)。数据制作核验所需的公开语义见[行为契约](../architecture/behavior-contracts.zh-CN.md)。

## 现有命令

命令在仓库根目录执行，以 [package.json](../../package.json) 为准。

| 命令 | 用途 |
| --- | --- |
| `bun run dev:desktop` | 准备开发资源并启动桌面 |
| `bun run typecheck` | 工作区 TypeScript 检查 |
| `bun run test:unit -- --stage P13` | 指定阶段的单元测试 |
| `bun run test:integration -- --stage P13` | 指定阶段的集成测试 |
| `bun run test:e2e -- --stage P13` | 指定阶段的终端产品与 Host 工作流检查 |
| `bun run test:e2e:desktop -- --stage P13` | 指定阶段的 Electron 桌面交互检查 |
| `bun run test:eval` | 评测设施工程测试 |
| `bun run build:desktop` | 准备桌面与随包生产资源 |
| `bun run package:desktop` | 构建 Windows x64 安装包 |

`P13` 是示例，应按改动选择 `P1` 至 `P17`。单元与集成命令必须提供 `--stage`，省略时返回 Usage，不运行测试。终端 e2e 与桌面命令省略阶段时，默认执行各自发现的全部阶段；它们支持 `--check`，例如 `bun run test:e2e:desktop -- --stage P13 --check`，仅列出选中文件并检查运行器，不执行测试，也不证明应用或模型就绪。参见[测试运行器](../../tests/run.ts)。

选择能够覆盖实际变更、调用方、持久化状态和取消路径的验证。确定性夹具与真实服务检查分别报告。端到端或模型评测前检查前置；外部请求可能计费并传输任务材料，见[评测说明](../evaluation/overview.zh-CN.md)。

## 文档与数据修改

公开专题使用英文 `.md` 与中文 `.zh-CN.md` 配对，互相链接并登记到[文档目录](../README.md)。同步修改两种语言及实际命令、源码链接，区分实现行为、未验证模型质量与计划能力。

五个本地计划和资料目录有意忽略，公开文档及数据制作检查不能依赖它们。迁移评测 Case 所引公开章节时，通过现有检查同步来源引用与核验记录，不能静默为改变的 Case、Gold 或评分内容背书。

贡献材料不包含真实凭据、私有数据根或本地运行原件。问题或改动说明应写出触发条件、预期与实际结果、脱敏错误、影响范围和已做验证。界面变更附聚焦的视觉和交互证据，不以未经执行的“全页面通过”代替。
