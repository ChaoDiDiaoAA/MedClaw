# 意图模型配置与排查

[English](configuration.md) · [识别流程](overview.zh-CN.md) · [文档目录](../README.md)

## 准备本地模型

单独安装并启动 Ollama，然后获取固定官方模型：

```powershell
ollama pull qwen3.5:0.8b
```

模型来源为 [Ollama 官方条目](https://ollama.com/library/qwen3.5:0.8b)。MedClaw 配置将标签固定为 `qwen3.5:0.8b`，不能将任意改名或微调模型视为等价的获准配置。

| 配置 | 当前契约 |
| --- | --- |
| 启用 | 默认关闭 |
| Base URL | 默认 `http://127.0.0.1:11434`；只接受数字 HTTP 回环地址 `127.0.0.1` 或 `[::1]`，可指定合法端口 |
| 模型标签 | `qwen3.5:0.8b` |
| 超时 | 默认 15000 毫秒，可配置 1000–60000 毫秒，同时受执行预算约束 |
| 核验记录 | 启用时必须提供非空证据引用 |

不接受远程主机、URL 凭据、查询参数及非数字回环别名，见[模型配置契约](../../packages/contracts/src/model.ts)。

## 桌面配置

1. 打开 **Models → Intent model**，核对 **Ollama URL** 与 **Model tag**。
2. 点击 **Verify local model**。应用读取本地服务与模型元信息，不下载模型，也不生成语义测试回答。
3. 在 **Verification record** 填写实际官方来源、身份和协议证据引用。输入这一字段本身不等于执行了语义评测。
4. 勾选 **Enable intent routing**，点击 **Apply configuration**。
5. 在 **Chat → Message routing** 选择 **Intent routing**，使用获准数据范围内的问题。

主 Agent 模型仍在 Models 中独立配置。切换到 **Main Agent** 是明确的用户选择。模型与配置变更用于后续获准输入，不会静默改变正在执行请求的既定配置。

## 常见问题

| 现象 | 检查或处理 |
| --- | --- |
| `intent_model_unavailable` | 核对服务、配置启用和发布、模型标签存在性与当前预算 |
| `intent_model_identity_mismatch` | 检查官方预期标签与返回身份是否一致，不能通过改名绕过 |
| `intent_response_invalid` / `intent_output_invalid` | 查看已保存的传输、输出和校验事实，HTTP 成功并不充分 |
| `intent_input_too_large` | 缩小获准问题或资料范围，不能静默丢弃必要条件 |
| 返回澄清 | 补齐真正缺少或有歧义的条件，不要只重复原请求 |
| 任务不受支持 | 核对能力表和已导入数据，标签本身不会增加工具或适配 |

报告问题时不要分享原始凭据、私有配置或不受限的执行原件。保留具体错误、相关 Run/Call 身份与脱敏条件，参见[本地适配器](../../packages/intent-ollama/src/index.ts)和[评测边界](../evaluation/overview.zh-CN.md#意图识别评测)。
