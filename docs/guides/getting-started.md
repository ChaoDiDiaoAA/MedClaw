# Getting started

[简体中文](getting-started.zh-CN.md) · [Documentation index](../README.md)

## Environment and current prerequisite

The current development target is Windows x64 with Bun `1.4.0` and Node.js 24. Business data and model services are prepared separately. Development startup also prepares runtime resources and bundled tools, which can require network access.

`package.json` declares the tracked [managed subagent patch](../../patches/@tintinweb%252Fpi-subagents@0.19.0.patch) for `@tintinweb/pi-subagents@0.19.0`. Keep it together with the lockfile when installing dependencies. The patch being present does not certify clean-machine installation, packaging or real-model behavior; those checks require their own evidence.

Run from the repository root:

```powershell
bun install --frozen-lockfile
bun run dev:desktop
```

The development data root is `.medclaw-dev/`; build output is `.build/`. To use a separate data root:

```powershell
bun run dev:desktop --data-root ..\medclaw-sandbox
```

Keep the same data root when testing saved-state recovery. Closing the app requests controlled shutdown; unresolved shutdown facts should be inspected rather than bypassed by deleting a writer lock.

## Configure a main model

1. Open **Models**, select a provider/model and authenticate using the method that provider supports.
2. Use **Set as default model**. **Test default model connection** makes a separate model request.
3. Create or select a Session in **Chat**. **Use for this session** selects a model for that Session.
4. Choose **Main Agent** in **Message routing** for normal model/tool execution.

Register compatible custom services under **Custom providers and models**, including their real API and capabilities. Keep secrets in the credential flow, not repository files or screenshots.

## Import and ask

Prepare a [supported snapshot package](data-import.md), then use **Data Workspace → Choose snapshot directory**, inspect its preview, and **Confirm import**. Select the relevant batches before asking a question or using **Query History** condition forms.

Start with a concrete object, region and available date. Inspect adopted conditions, actual dates, result population and evidence. When asking a follow-up, check which conditions were retained or corrected. A missing date or field is not a zero value.

## Enable intent recognition separately

The local intent model is independent of the main model and disabled by default. Follow [intent model configuration](../intent/configuration.md) to prepare Ollama, inspect the official model, record actual protocol evidence, apply configuration and select **Intent routing** in Chat. Read [recognition and routing](../intent/overview.md) before interpreting clarification or unsupported-task responses.

## Next steps

- [Prompt and Skills](prompts-and-skills.md): optimize prompts, choose input commands and inspect resource readiness.
- [Read-only subagents](../agents/subagents.md): roles, explicit delegation, parallel work and cancellation.
- [Data import and queries](data-import.md): package and result semantics.
- [Evaluation](../evaluation/overview.md): engineering checks, real trials and reports.
- [Windows packaging and maintenance](../release/windows-packaging.md): installation and backup boundaries.
- [Product overview](../product/overview.md): capability limits and external data processing.
