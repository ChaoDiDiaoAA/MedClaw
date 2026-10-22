# Prompt 与 Skills

[English](prompts-and-skills.md) · [文档目录](../README.md)

MedClaw 将提示词编辑、有版本的 Prompt 模板、Skill 指令、子代理角色和已注册扩展命令分开。指令或资源选择不能产生执行授权。发起模型请求前，先配置[主模型](getting-started.zh-CN.md)。

## 优化提示词

打开 **Prompt**，使用 **Prompt optimizer**：

1. 填写 **Original prompt** 和可选 **Requirements**，选择 **Optimize**，请求已发布的主模型修改提示词。这是真实模型请求，受 Host 状态、根任务占用和模型配置约束。
2. 核查输出。流式文本是预览，完成后完整的已保存输出才可编辑。优化指令要求修改提示词，不执行被引用的原任务。
3. 按需编辑结果。**Copy** 复制到剪贴板，**Use in chat** 将结果追加到当前已确认 Session 的草稿；它不会发送草稿，也不会创建已保存的 Prompt 模板版本。

已经提交的优化文本和输出保存为 Provider Run，未提交的编辑草稿保留在当前窗口，不应假定关闭窗口后仍然存在。使用外部主模型时，优化材料会发送给该服务。完成优化不能证明新提示词提高了任务质量。

进行中可使用 **Stop**。接收或完成情况未知时，**Read original result** 读取原操作，不应另发一次优化来猜测结果。已经取得的结果需要持久化时显示 **Retry saving**。失败或取消会保留上一份草稿，清理确认后才能把操作视为已经释放。

## 选择输入类型

在 Session 已确认时，在 Chat 输入 `/` 查看可用命令：

| 分组 | 输入 | 含义 |
| --- | --- | --- |
| **Skills** | `/skill:<id> ...` | 通过受控输入路径明确加载所选版本的 Skill 指引 |
| **Subagents** | `/subagent <角色ID> <任务>` | 准备具名、前台、只读委派请求 |
| **Prompt Templates** | `/<prompt-id> ...` | 展开启用的有版本 Prompt 模板；委派模板单独记录来源 |
| **Extension Commands** | `/extension_status` 等已注册命令 | 使用真实注册和对应产品入口；可用性绑定其所有者和执行状态 |

菜单是目录，不证明处理器已经执行，不可用条目保留原因。`/medclaw-evidence-review` 和 `/parallel-medclaw-review` 准备委派指令，不是普通业务 Prompt 版本；角色校验与真实 `Agent` 调用见[子代理](../agents/subagents.zh-CN.md)。已注册的 `/extension_status` 应使用扩展支持的产品控制，不作为普通 Chat 消息提交。

Session 选择的业务 Prompt、启用的 Prompt 模板和优化草稿是不同输入。核查模型收到的内容时，应查看获准 Run 记录的资源与实际消费文本。

## 选择 Skills 与核查就绪状态

**Skills** 列出资源版本、描述、依赖声明和诊断。没有选择 Session 时也可以浏览目录；启用版本或读取 Session 选择需要对应的已确认 Session。目录条目不能证明资源已经启用或使用。

必需工具的匹配包含五种状态：

| 状态 | 含义 |
| --- | --- |
| `ready` | 所有声明的必需工具均匹配本次比较的可用工具集合 |
| `partial` | 部分必需工具匹配，部分缺失 |
| `unavailable` | 声明的必需工具没有匹配项 |
| `unknown` | 缺少依赖声明或必要的可用工具信息 |
| `no_requirements` | Skill 明确声明没有必需工具 |

**Configuration preview** 按配置比较，**Run scope** 按原获准 Run 比较，两者依据不同。必需扩展和资源本身的有效性另有诊断。工具匹配不能产生授权，不能证明模型已经读取或遵循 Skill，也不能证明结果质量。

获准 Run 保留其资源版本和捕获的内容，后续配置或文件变化不会改写历史。资源发现、原生文件读取、SDK 展开、供应商请求交付和遵循指令是不同事实。报告成功使用前，应核查已保存的资源依据与原 Run。

## 排查资源不可用

先确认 Host 和 Session，再检查准确版本、必需工具与扩展及诊断原因。无效或缺失的资源应保持不可用状态，不能为消除提示而替换来源或扩大权限。检查活动 Run 时应读取其原始范围和快照，不能用当前目录反推历史可用性。

参见[系统架构](../architecture/overview.zh-CN.md)、[评测](../evaluation/overview.zh-CN.md)和[界面规则](../ui/ui-system.zh-CN.md)。源码：[资源契约与就绪计算](../../packages/contracts/src/resources.ts)、[资源服务](../../packages/core/src/resources/resource-service.ts)、[输入适配](../../packages/runtime-pi/src/input-adapter.ts)、[Prompt 优化器](../../apps/desktop/src/renderer/prompt-workbench.tsx)、[Skills 界面](../../apps/desktop/src/renderer/resource-panel.tsx)。
