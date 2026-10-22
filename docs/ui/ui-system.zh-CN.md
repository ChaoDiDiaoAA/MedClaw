# UI 系统

[English](ui-system.md) · [文档目录](../README.md)

本页说明当前桌面界面，不是重新设计方案。实现见 [React 界面源码](../../apps/desktop/src/renderer)与 [styles.css](../../apps/desktop/src/renderer/styles.css)。

## 基础与工作台

当前样式使用 Segoe UI / Microsoft YaHei UI、14 像素基础字号、中性背景、克制边框和玫红强调色，样式表定义浅色与深色变量组。复用 `--canvas`、`--surface`、`--muted`、`--line`、`--accent` 等现有 CSS 变量，不建立平行变量体系。按钮区分主要、安静、危险和禁用状态，键盘焦点具有可见轮廓。

工作台包含可折叠导航、主工作区和可选详情栏。主对话承担连续阅读，详细事实和高级操作放入对应任务区域、折叠区或详情栏。滚动归属于相应页面或面板，长标签、身份标识和错误应换行，不能遮挡必要操作。

## 导航与页面模式

| 区域 | 当前入口 |
| --- | --- |
| Chat | 会话、消息路由、模型选择、输入、执行状态和子任务卡片 |
| Data Workspace | 数据根、导入预览、批次选择与删除 |
| Query History | 采用条件、已保存结果、依据与显式导出 |
| Models | 供应商和模型配置，以及独立 Intent model 面板 |
| Prompt | 提示词优化、已保存结果核查、复制和填入 Chat 草稿 |
| Skills | 可搜索的资源目录、版本、依赖声明和就绪状态 |
| Extensions | 只读 Agent 管理与受信扩展控制 |
| Evaluation | 独立评测控制与结果查看 |
| Settings | 应用设置、诊断与维护 |

中英文文档都保留实际页面标签，便于在产品中定位。意图模型设置与 Chat 的 **Message routing** 是两个不同入口，参见[意图配置](../intent/configuration.zh-CN.md)。

导航分为 **Work**（Chat、Data Workspace、Query History）、**Models & Resources**（Models、Prompt、Skills、Extensions）和 **Quality**（Evaluation），**Settings** 与 Host 状态位于导航底部。页面按任务组织操作；Settings 分为 **General**、**Runtime**、**Backup and restore**、**Support**，以及可用时的 **Business prompt** 区域。

目录浏览与 Session 配置是不同状态。没有已确认 Session 时，可读目录不代表可以执行 Session 选择、角色编辑或任务，应保留对应的空状态、不可用原因和诊断。斜杠菜单区分 Skills、Subagents、Prompt Templates 与 Extension Commands，见[Prompt 与 Skills](../guides/prompts-and-skills.zh-CN.md)。子任务卡片与已记录角色详情见[子代理](../agents/subagents.zh-CN.md)。

## 状态与交互规则

加载、能力不可用、合法空结果、请求失败、取消和结果未知分别表达。价格缺失不是零，流式文本停止也不证明保存或进程清理完成。保留相关错误，并在支持时提供具体恢复操作。

根据真实产品状态禁用操作，控件与标签关联，保留键盘焦点，破坏性选择明确呈现。界面显示状态不产生文件系统或 Host 授权，操作通过 [Preload 白名单](../../apps/desktop/src/preload/index.ts)。

## 聚焦视觉核验

对受影响页面核查正常、加载、空结果、错误、取消和禁用状态，以及键盘操作、长内容、窗口尺寸和相关 Windows 缩放档位。增加控件后复核主栏、详情栏布局和滚动归属。报告实际覆盖范围，不声称所有配置均已验证。
