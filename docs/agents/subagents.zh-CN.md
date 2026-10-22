# 只读子代理

[English](subagents.md) · [文档目录](../README.md)

主 Agent 可以通过 `Agent` 工具委派独立、前台、只读的工作。每个子任务都有自己的 Session、Run、原生历史和原始父 ToolCall。父 Agent 负责核查结果并形成最终回答。角色已登记或命令已选择，本身不能证明子任务已经执行。

## 内置角色

| 角色 | 适用工作 | 工具边界 |
| --- | --- | --- |
| `medclaw-audit` | 核查任务材料、已保存查询与依据 | 声明的文件读取和业务读取工具，同时受父任务获准范围约束 |
| `general-analyst` | 独立分析父任务明确提供的材料 | `tools: []`，没有文件、业务、终端或委派工具 |

角色声明指令和工具，不单独选择模型或执行预算。子任务使用父任务解析后的模型和受控执行配置。声明不能授予获准只读集合或父任务范围之外的工具，子任务也不能再次委派。参见[公开子代理契约](../architecture/behavior-contracts.zh-CN.md#只读子-agent)。

## 从 Chat 使用

先配置[主模型](../guides/getting-started.zh-CN.md)，选择已确认的用户 Session 和相关数据范围，再输入明确请求，例如：

```text
/subagent general-analyst 检查以下所提供分析中的假设：……
/medclaw-evidence-review 核查本次查询的依据，指出覆盖缺口。
/parallel-medclaw-review 分别核查所提供的分析和查询依据。
```

`/subagent <角色ID> <任务>` 通过已注册命令准备具名委派请求。两个具名模板分别要求主 Agent 调用 `medclaw-audit`，或者同时调用 `medclaw-audit` 与 `general-analyst`。这些输入作为新的 Send 操作接收，不能排入 Steer 或 Follow-up；它们使用委派输入路径，不经过本地意图分类。只有主 Agent 实际发起 `Agent` 工具调用才会创建子任务，执行情况应通过已保存的子任务事实核查。模板要求两次调用，不保证特定模型一定照做。

斜杠菜单将 **Skills**、**Subagents**、**Prompt Templates** 和 **Extension Commands** 分组显示，不可用条目显示对应原因。不同输入类型见[Prompt 与 Skills](../guides/prompts-and-skills.zh-CN.md)。

## 管理角色文件

在用户 Session 已确认、Host 就绪时打开 **Extensions → Manage agents**。通过 **Edit agent**、**New agent** 和 **Save agent** 管理角色内容。编辑内置角色会保存用户覆盖文件。内置文件位于安装资源根的 `subagents/`，用户文件位于 `<dataRoot>/subagents/<角色ID>.md`，与源码检出目录分开。

角色使用严格的 frontmatter 和非空指令正文。例如：

```yaml
---
name: supplied-reviewer
description: Review only the material supplied by the parent.
tools: []
---
Identify assumptions and missing information. Do not claim to inspect external sources.
```

文件名须匹配小写角色 ID。接受的 frontmatter 字段为 `name`、`description`、`tools`；模型、cwd、后台执行等不是角色选项。每个文件最多 64 KiB，角色目录最多 128 个 ID。用户覆盖无效时会阻止该 ID 使用，不会静默回退到内置角色。路径、编码、大小和工具检查都可能使角色不可用。

保存时直接比较原始内容，避免过期编辑器覆盖较新版本。冲突会保留草稿，应明确读取当前角色再替换。回复丢失时，使用 **Verify agent save** 核查已保存内容后再决定下一次保存。Run 获准时会捕获角色内容：修改用于后续 Run，已经接收的 Run 保留原快照。没有记录角色快照的旧 Run 不会使用今天的文件补造历史。

## 并行、预算与停止

同时最多持有四个子执行。第五次调用会返回忙碌，直到一个槽位释放。已经结束但结果保存或清理尚未确认的子任务仍然占位；这不是一个 Run 整个生命周期只能创建四个子任务。

父子任务共享根任务的模型调用预算和执行截止时间，独立历史不代表各自拥有无限预算。应检查真实工具范围和剩余额度，不能假定角色一定可执行。

Chat 显示子任务卡片，**View Subagent Run** 打开原子任务详情。**Stop Subagent Run** 请求取消该子任务，父任务与其他子任务可以继续。停止父任务会请求取消其子任务，必要的停止、保存和清理确认前仍保留根任务所有权。取消请求本身不证明执行已经停止。

## 结果核查与限制

核查原父 ToolCall、子任务身份、已记录角色、结果、依据引用、清理状态和父调用回执。子结果已提交、SDK 已返回、后续父模型请求中已核实交付，以及最终回答采用是不同事实。作为回答依据使用前，应读取并核验引用结果。

[意图路由](../intent/overview.zh-CN.md)选择主 Agent 执行时，父任务可以使用只读助手。经过校验的查询步骤和最终 Answer 仍属于父任务，角色指令不能更改已接受的意图参数、QueryContext 或授权。

配置外部模型时，父子请求所需的材料会发送给该服务；本地保存不代表本地推理。工程夹具可以核验所有权、并行准入和取消，但不能证明委派有用或真实模型质量。参见[评测](../evaluation/overview.zh-CN.md)。

源码：[角色契约](../../packages/contracts/src/subagent.ts)、[角色加载与保存](../../packages/runtime-pi/src/resource-loader.ts)、[受控委派](../../packages/runtime-pi/src/subagent-adapter.ts)、[运行所有权](../../packages/core/src/runtime/runtime-service.ts)、[角色管理界面](../../apps/desktop/src/renderer/extensions-page.tsx)。
