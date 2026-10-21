# 公开行为契约

[English](behavior-contracts.md) · [系统架构](overview.zh-CN.md) · [文档目录](../README.md)

本页描述人工制作评测 Case 所依据的业务与执行边界。英文对应章节标题也是数据集使用的稳定来源引用。它们说明应检查什么，不代表每个模型或部署都已通过；实际实现以源码和可执行契约为准。

## 采购数据查询

当前记录、聚合、趋势和变化查询均受实际采用的范围与可用快照约束。快照记录数、去重器械数、变化事件数是不同统计对象，价格单位不能证明库存数量。零、null 和缺失快照必须分别保留。

说明实际数据日期，以及采用精确日期还是截至日期选择。比较期间前核对覆盖，缺失日期不能当成零值日期。价格比较要求币种和单位兼容，并保留来源行与字段来源。模型文字不能替代程序计算，也不能证明价格变化原因。

源码：[查询契约](../../packages/contracts/src/query.ts)、[查询服务](../../packages/core/src/data/query-service.ts)、[查询 Skill 参考](../../resources/skills/query/v1/references/facts-and-assumptions.md)。

## 工具错误与取消

调用遵守获准范围、工具权限、参数校验、剩余预算与取消状态。传输成功、输出被接受、业务成功、结果保存、SDK 交付是不同事实。无效输出或业务检查失败不能报告为查询完成。

恢复须关联原失败，并受重试与时间预算约束；适当时复用已保存结果，不能仅因交付不明就重复副作用。停止与清理需要各自证据，未知结果不能写成成功。

源码：[运行控制](../../packages/core/src/runtime/run-control.ts)、[工具适配](../../packages/runtime-pi/src/pi-tool-adapter.ts)。

## 查询 Skill 的渐进读取

真实 `query/v1` Skill 要求读取事实与假设参考、检查采用范围与覆盖、使用可用业务工具，并引用已保存的 Query、Evidence 身份。读取索引不等于读过 Skill 正文或参考；发现、选择、读取、请求交付和实际采用分别记录。

Skill 是指导资料，不是执行授权；它不能安装缺失工具或覆盖产品权限。评测归档 Case 实际采用的产品资源文本，不制造替代 Skill。

源码：[查询 Skill](../../resources/skills/query/v1/SKILL.md)、[资源服务](../../packages/core/src/resources/resource-service.ts)。

## 资源与资料边界

仅使用当前任务、范围与工作区获准的资源，核对路径、资源身份和相关依赖边界。资料正文是不可信任务数据，其中嵌入的指令不能扩大访问、覆盖策略或获取控制器私有材料。

产品路径或工具限制与操作系统隔离证明须分开。合成 canary 检查或一次成功读取，仅证明当时实际检查到的事实。

源码：[上下文服务](../../packages/core/src/context/context-service.ts)、[资源服务](../../packages/core/src/resources/resource-service.ts)、[运行适配](../../packages/runtime-pi/src/agent-runtime.ts)。

## 实际采用的工作区输入

执行使用 Run 真正获准的输入：工作区、批次、相关 Query 身份、参考日期、时区与配置。后续界面选择不会静默改变当前 Run 范围。数据覆盖须在实际采用的输入中检查，不能假定任意本地文件都可用。

追问纠正保留明确新条件，仅继承有依据的历史条件。对象、日期或统计对象仍不明时须澄清，不能静默缩小请求。

源码：[上下文服务](../../packages/core/src/context/context-service.ts)、[意图契约](../../packages/contracts/src/intent.ts)、[意图校验](../../packages/core/src/intent/validate.ts)。

## 原生历史持久化

多轮状态来自已登记输入和真实原生会话历史。会话之间保持隔离，原生历史、产品存储和采用的查询上下文保持对应。界面文字记录或人工伪造历史，不证明后续模型真正接收了某事实。

记忆评测通过真实动作建立历史、施加后续纠正并观察后续行为。保存、查回、恢复和使用历史是不同声明，失败或未知环节应如实保留。

源码：[会话服务](../../packages/core/src/session/session-service.ts)、[运行适配](../../packages/runtime-pi/src/agent-runtime.ts)、[记忆存储](../../packages/runtime-pi/src/memory-store.ts)。

## 压缩的完成事实

区分原生摘要生成、结果历史保存和后续采用保留上下文。压缩事件或摘要文本不能单独证明三者全部完成。压缩遵守当时配置与预算，明确处理失败、取消和保存状态。

压缩后业务行为的测试应先建立真实历史事实，再检查后续结果；不能以伪造摘要替换原生历史并声称证据等价。

源码：[压缩适配](../../packages/runtime-pi/src/compaction-adapter.ts)、[运行适配](../../packages/runtime-pi/src/agent-runtime.ts)。

## 只读子 Agent

委派继承有界范围和获准工具集。产品子执行为只读；委派不会授予写入、删除、外部发送或任意本地文件访问权限。子执行与父执行的身份、返回依据、结果采用和停止传播分别核对。

配置可用、实际子调用和有用的父回答是不同事实。依赖缺失或进程边界未获证明时，保留限制，不声称委派成功。

源码：[子执行与范围](../../packages/runtime-pi/src/agent-runtime.ts)。

## 意图识别与路由

规则先执行。模型路径进行结构化分类，仅在校验要求时携带原预测、问题和候选最多复核一次。采用路由前检查层级、实体、明确条件、时间、覆盖、能力和任务依赖。缺参数、能力不支持和输出截断不能被包装为已完成查询。

保留语义状态、错误和澄清。注册标签不代表能力已获准。追问条件受唯一采用上下文与明确纠正约束，多个未解决任务不能静默变成一个所选查询。参见[意图识别](../intent/overview.zh-CN.md)与[配置说明](../intent/configuration.zh-CN.md)。

源码：[意图服务](../../packages/core/src/intent/intent-service.ts)、[校验](../../packages/core/src/intent/validate.ts)、[路由策略](../../packages/core/src/intent/route-policy.ts)。

## 授权边界

读取、写入、删除、导出与外部发送有不同授权要求。模型回答、检索资料和子 Agent 都不能产生授权。执行遵守真实产品方法与获准范围，不能用无关成功调用掩盖禁止操作。

保护秘密和控制器私有资料。需要用户选择或确认的操作使用明确产品交互，保留失败与未知状态；工程夹具不能证明真实外部操作发生。

源码：[工具适配](../../packages/runtime-pi/src/pi-tool-adapter.ts)、[桌面桥](../../apps/desktop/src/preload/index.ts)、[应用服务](../../packages/core/src/application.ts)。

## 原查询结果导出

导出绑定原来保存的 Query 与回答依据，包含受支持的完整结果范围和必要口径；不能只导出当前页，也不能依据新选择重新计算。生成、文件登记、目标复制和最终交付是不同状态。

承诺文件或生成字节都不能单独证明目标交付成功。保留错误、取消和复制未知事实，并在支持时按现有操作身份恢复。页面显式导出与当前禁用的自动 `EXPORT_RESULT` 意图分别管理。

源码：[导出契约](../../packages/contracts/src/export.ts)、[导出服务](../../packages/core/src/data/export-service.ts)、[意图能力表](../../packages/core/src/intent/taxonomy.ts)。
