# 评测与结果核查

[English](overview.md) · [文档目录](../README.md) · [CLI 详细说明](../../agent-eval/README.md)

## 架构与证据

评测配置独立于聊天。Case 声明输入、夹具、预算和预期检查，Trial 记录一次执行。运行器收集产品观测与文件，确定性评分检查适用事实，独立配置的 Judge 处理适用语义评分。报告保留证据与未解决缺口，不把检查不可用改成通过。

当前主数据集 `medclaw-agent-v1` 有 50 个开发可见、人工制作的合成 Case，并声明十题 Smoke 子集。合成业务事实和独立 CSV/Decimal 重算与生产轨迹分别对待。补充 badcase 数据集保留历史来源缺失阻碍，工程来源夹具不等于恢复已删除的真实问题记录。

[公开行为契约](../architecture/behavior-contracts.zh-CN.md)提供制作核验所需的产品来源章节。Case、Gold、来源引用、编译检查和制作审核必须一致。数据审核不代表真实模型质量，运行工程检查不能把 `qualityRuns: NOT_RUN` 改成质量通过。

## 配置与执行

使用现有 [agent.example.json](../../agent-eval/configs/agent.example.json)和 [environment.example](../../agent-eval/configs/environment.example)准备私有 `agent-eval/configs/agent.json` 与 `environment`。Agent、Judge 分别配置，且与桌面聊天模型分开。真实秘密和私有配置不纳入 Git。

```powershell
bun run eval:smoke -- --check
bun run eval:full -- --check
```

上述命令检查前置与配置，不证明评测已经完成。前置满足后，`bun run eval:smoke`、`bun run eval:full` 会执行真实配置的任务，可能传输材料和产生费用。预设默认 Smoke 每题一次 Trial、Full 每题三次；需要改变重复次数时使用已说明的 `--trials`。

结果先保存在本地。已有归档上传和反馈同步分别显式发起，不由评测启动隐含触发。例如先查看 `bun run eval:upload -- --help`，再选择真实执行归档上传。桌面 **Evaluation** 使用独立评测设施，不等于发送 Chat 消息。

## 意图识别评测

逐层核查[识别链路](../intent/overview.zh-CN.md)：规则结果、层级与参数、实体和时间落地、澄清或不支持响应、采用路由、实际 Query 结果与依据。结构正确仍可能语义错误，标签正确也可能缺少可执行能力。

示例包括 `mc-v1-intent-resolve` 和 `mc-v1-intent-clarify-region`。工程测试检查 Schema、有界复核和路由行为；固定官方 0.8B 模型的真实评测须检查真实请求与结果，包括歧义表达、明确纠正和不支持任务。元信息核验不测语义准确率，本页不提供未实测准确率。

## 报告与比较

通过已保存的 Case、Trial 和执行身份定位原件，分别检查最终事实、工具选择、参数、来源使用、延迟、恢复和未知状态。重复试验仅在条件兼容、保留真实分母和缺口时支持成功率、pass@k 与波动分析。Judge 失败或必要依据缺失可能使结果不可判定。

CLI README 中历史工程计数仍是带日期事实，不是当前发布认证。比较真实报告与配置，不能因更改提示词或一次回答更好就推断因果改进。

## 工程核验

```powershell
bun run test:eval
bun test agent-eval/tests/datasets
python agent-eval/scripts/verify-stage-one.py
python -O agent-eval/scripts/verify-stage-one.py
```

Python 默认独立核验主数据集，不调用模型。补充数据集的历史来源核验仍需要真实原件。普通与优化 Python 路径须保留同样检查。相关源码：[数据集载入](../../agent-eval/src/datasets.ts)、[独立核验器](../../agent-eval/scripts/verify-stage-one.py)、[核验记录器](../../agent-eval/scripts/record-data-checks.ts)、[数据集测试](../../agent-eval/tests/datasets)。
