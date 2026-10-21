# Intent model configuration and troubleshooting

[简体中文](configuration.zh-CN.md) · [Recognition pipeline](overview.md) · [Documentation index](../README.md)

## Prepare the local model

Install and start Ollama separately, then obtain the fixed official model:

```powershell
ollama pull qwen3.5:0.8b
```

The model source is [Ollama's official library entry](https://ollama.com/library/qwen3.5:0.8b). MedClaw's configuration fixes the tag to `qwen3.5:0.8b`; an arbitrary renamed or fine-tuned model is not an equivalent accepted configuration.

| Setting | Current contract |
| --- | --- |
| Enabled | Off by default |
| Base URL | Default `http://127.0.0.1:11434`; numeric HTTP loopback `127.0.0.1` or `[::1]`, with an optional valid port |
| Model tag | `qwen3.5:0.8b` |
| Timeout | Default 15000 ms; configurable from 1000 to 60000 ms, also subject to execution budget |
| Verification record | A nonblank evidence reference is required when enabling routing |

Remote hosts, URL credentials, query strings and non-loopback aliases are not accepted. See [model configuration contracts](../../packages/contracts/src/model.ts).

## Configure the desktop

1. Open **Models → Intent model** and check **Ollama URL** and **Model tag**.
2. Click **Verify local model**. The application reads local service/model metadata; it does not download a model or generate a semantic test response.
3. Fill **Verification record** with the actual official-source, identity and protocol evidence reference. Entering text in this field does not itself perform a semantic evaluation.
4. Select **Enable intent routing**, then **Apply configuration**.
5. In **Chat → Message routing**, select **Intent routing** and use data within the admitted scope.

The main Agent model remains configured separately in Models. Switching to **Main Agent** is an explicit user choice. Model and configuration changes apply to later admitted input; they do not silently alter a running request's captured configuration.

## Troubleshooting

| Observation | Check or action |
| --- | --- |
| `intent_model_unavailable` | Verify service availability, enabled/published configuration, tag presence and current budget |
| `intent_model_identity_mismatch` | Check that the official expected tag and returned identity match; do not bypass the check by relabeling a model |
| `intent_response_invalid` / `intent_output_invalid` | Inspect the saved transport/output/validation facts; a valid HTTP response is not sufficient |
| `intent_input_too_large` | Reduce the admitted question/material scope; do not silently drop required conditions |
| A clarification is returned | Supply the actual missing or ambiguous condition rather than repeatedly submitting the same request |
| A task is unsupported | Check the capability map and imported data; a taxonomy label alone does not add a tool or adapter |

Do not share raw credentials, private configuration or unrestricted execution originals when reporting a problem. Preserve the exact error, relevant run/call identity and redacted conditions. See [the local adapter](../../packages/intent-ollama/src/index.ts) and [evaluation boundaries](../evaluation/overview.md#intent-recognition-evaluation).
