# MedClaw 文档 / Documentation

面向使用者、结果核查者和开发维护者的公开文档。中文与英文描述同一套实现；命令、页面名称和协议标识保留原文。功能存在、工程检查通过与真实模型效果分别判断。

Public documentation for users, result reviewers, and contributors. Chinese and English describe the same implementation. Commands, UI labels, and protocol identifiers retain their original spelling. Implemented behavior, engineering verification, and real model quality are separate claims.

## 阅读顺序 / Reading paths

- 首次使用 / First use: 产品概览 → 使用入门 → 数据导入。
- 意图识别 / Intent recognition: 识别流程 → 本地模型配置 → 评测与限制。
- Agent 与资源 / Agents and resources: Prompt 与 Skills → 只读子代理 → 执行与依据核查。
- 开发维护 / Development: 系统架构 → 行为契约 → 开发指南 → Windows 打包。

| 专题 / Topic | 简体中文 | English |
| --- | --- | --- |
| 产品 / Product | [产品概览](product/overview.zh-CN.md) | [Overview](product/overview.md) |
| 入门 / Getting started | [使用入门](guides/getting-started.zh-CN.md) | [Getting started](guides/getting-started.md) |
| 数据 / Data | [数据导入与查询](guides/data-import.zh-CN.md) | [Data import and queries](guides/data-import.md) |
| 意图识别 / Intent | [识别流程](intent/overview.zh-CN.md) | [Recognition pipeline](intent/overview.md) |
| 意图配置 / Intent setup | [配置与排查](intent/configuration.zh-CN.md) | [Configuration and troubleshooting](intent/configuration.md) |
| 子代理 / Subagents | [只读子代理](agents/subagents.zh-CN.md) | [Read-only subagents](agents/subagents.md) |
| Prompt 与 Skills / Prompt and Skills | [使用与核查](guides/prompts-and-skills.zh-CN.md) | [Usage and verification](guides/prompts-and-skills.md) |
| 架构 / Architecture | [系统架构](architecture/overview.zh-CN.md) | [System architecture](architecture/overview.md) |
| 契约 / Contracts | [公开行为契约](architecture/behavior-contracts.zh-CN.md) | [Public behavior contracts](architecture/behavior-contracts.md) |
| 开发 / Development | [开发与贡献](development/contributing.zh-CN.md) | [Development and contributing](development/contributing.md) |
| 界面 / UI | [UI 系统](ui/ui-system.zh-CN.md) | [UI system](ui/ui-system.md) |
| 评测 / Evaluation | [评测与结果核查](evaluation/overview.zh-CN.md) | [Evaluation and result review](evaluation/overview.md) |
| 发布 / Release | [Windows 打包与维护](release/windows-packaging.zh-CN.md) | [Windows packaging and maintenance](release/windows-packaging.md) |

## 文档边界 / Documentation boundaries

公开说明以当前源码和契约为依据，不把内部计划或历史验收记录当作当前能力证明。`evals/`、`plans/`、`prompt/`、`PT/`、`spec/` 是本地资料目录，不属于公开文档依赖。业务数据、凭据和执行原件按各自的本地配置管理。

Public descriptions follow current source and contracts. Internal plans and historical acceptance notes do not establish current capabilities. `evals/`, `plans/`, `prompt/`, `PT/`, and `spec/` are local material directories and are not dependencies of this public documentation. Business data, credentials, and execution originals remain subject to their local configuration.

专题组织参考 [Folio](https://github.com/helsome/folio/tree/main/docs)，内容与边界按 MedClaw 实现重新编写。

The topic organization takes inspiration from [Folio](https://github.com/helsome/folio/tree/main/docs); content and boundaries are written for MedClaw.
