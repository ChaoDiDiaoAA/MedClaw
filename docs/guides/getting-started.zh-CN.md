# 使用入门

[English](getting-started.md) · [文档目录](../README.md)

## 环境与当前前置条件

当前开发目标为 Windows x64，使用 Bun `1.4.0` 与 Node.js 24。业务数据和模型服务单独准备。开发启动还会准备运行资源与随包工具，可能需要访问下载源。

**已知干净安装阻碍：** `package.json` 与锁文件声明了 `@tintinweb/pi-subagents@0.19.0` 的补丁，但已跟踪源码缺少对应文件。需要维护者补齐前置，才能核验干净依赖安装与完整构建。本指南不声称当前干净克隆已经能够直接安装成功。

前置处理后，在仓库根目录执行：

```powershell
bun install --frozen-lockfile
bun run dev:desktop
```

开发数据根为 `.medclaw-dev/`，构建产物位于 `.build/`。使用独立数据根：

```powershell
bun run dev:desktop --data-root ..\medclaw-sandbox
```

测试已保存状态恢复时保持同一数据根。关闭应用会请求受控退出；停写事实无法确认时应检查状态，不能靠删除写入锁绕过。

## 配置主模型

1. 打开 **Models**，选择供应商和模型，使用该供应商支持的方式认证。
2. 使用 **Set as default model**。**Test default model connection** 会独立发起模型请求。
3. 在 **Chat** 创建或选择 Session；**Use for this session** 为该会话选择模型。
4. 在 **Message routing** 中选择 **Main Agent**，进行常规模型与工具执行。

兼容的自定义服务在 **Custom providers and models** 登记，填写真实 API 与能力。秘密通过凭据流程输入，不放入仓库文件或截图。

## 导入与提问

准备[受支持的快照包](data-import.zh-CN.md)，打开 **Data Workspace → Choose snapshot directory**，核查预览并 **Confirm import**。提问或使用 **Query History** 条件表单前，选择相关批次。

先提出对象、地区和可用日期明确的问题，核查采用条件、实际日期、统计对象和依据。连续追问时检查哪些条件被继承或纠正，缺失日期或字段不能当成零。

## 单独启用意图识别

本地意图模型独立于主模型，默认关闭。按[意图模型配置](../intent/configuration.zh-CN.md)准备 Ollama、核验官方模型、记录真实协议依据、应用配置，再在 Chat 选择 **Intent routing**。解释澄清或不支持响应前，请阅读[识别与路由流程](../intent/overview.zh-CN.md)。

## 后续阅读

- [数据导入与查询](data-import.zh-CN.md)：数据包和结果口径。
- [评测](../evaluation/overview.zh-CN.md)：工程检查、真实试验和报告。
- [Windows 打包与维护](../release/windows-packaging.zh-CN.md)：安装和备份边界。
- [产品概览](../product/overview.zh-CN.md)：能力限制和外部数据处理。
