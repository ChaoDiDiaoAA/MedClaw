# Prompt and Skills

[简体中文](prompts-and-skills.zh-CN.md) · [Documentation index](../README.md)

MedClaw separates prompt editing, versioned prompt templates, Skill instructions, subagent roles and registered extension commands. An instruction or a resource selection cannot grant execution permissions. Configure a [main model](getting-started.md) before making a model request.

## Optimize a prompt

Open **Prompt** to use **Prompt optimizer**:

1. Enter **Original prompt** and optional **Requirements**. Choose **Optimize** to request a revision from the published main model. This is a real model request, subject to Host state, root execution availability and model configuration.
2. Inspect the output. Streaming text is a preview; the complete saved output becomes editable after completion. The optimization instruction asks for prompt revision, not execution of the quoted task.
3. Edit the result if needed. **Copy** copies it to the clipboard. **Use in chat** appends it to the current confirmed Session's draft; it does not send the draft or create a saved prompt-template version.

Submitted optimization text and output are stored as a Provider Run. Unsubmitted editing drafts remain in this window; do not assume they survive closing it. An external main model receives the optimization material. Optimizing a prompt does not prove that the revised prompt improves task quality.

Use **Stop** for an in-progress optimization. If acceptance or completion is unknown, **Read original result** reads the original operation; do not send another optimization to guess its outcome. **Retry saving** appears when the acquired result needs persistence. Failure or cancellation retains the previous draft, and cleanup must be confirmed before the operation is treated as released.

## Choose an input type

With a confirmed Session, type `/` in Chat to inspect the available commands:

| Group | Input | Meaning |
| --- | --- | --- |
| **Skills** | `/skill:<id> ...` | Explicitly load the selected version's Skill guidance through the controlled input path |
| **Subagents** | `/subagent <role-id> <task>` | Prepare a named, foreground, read-only delegation request |
| **Prompt Templates** | `/<prompt-id> ...` | Expand an enabled versioned prompt template; the delegation templates have their own recorded source |
| **Extension Commands** | A registered command such as `/extension_status` | Use the command's actual registration and product entrypoint; availability is tied to its owner and execution state |

The menu is a directory, not proof that a handler ran. Unavailable items retain their reasons. `/medclaw-evidence-review` and `/parallel-medclaw-review` prepare delegation instructions rather than ordinary business-prompt versions; their role checks and actual `Agent` calls are explained in [subagents](../agents/subagents.md). The registered `/extension_status` command uses the extension's supported product control rather than an ordinary Chat submission.

The business prompt selected for a Session, an enabled prompt template and an optimization draft are different inputs. Review the accepted Run's recorded resources and consumed text when checking what reached the model.

## Select Skills and inspect readiness

**Skills** lists resource versions, descriptions, declared requirements and diagnostics. Catalog browsing can be available without a selected Session; enabling a version or reading a Session selection requires the corresponding confirmed Session. A catalog entry is not proof that the resource was enabled or used.

The required-tool comparison has five states:

| State | Meaning |
| --- | --- |
| `ready` | Every declared required tool matches the comparison's available tool set |
| `partial` | Some required tools match and some are missing |
| `unavailable` | None of the declared required tools match |
| `unknown` | Required declarations or the necessary available-tool information are missing |
| `no_requirements` | The Skill explicitly declares no required tools |

**Configuration preview** compares against configuration; **Run scope** compares against the original accepted Run. These are different bases. Required extensions and resource validity have their own diagnostics. A tool match cannot grant authorization, prove the model read or followed a Skill, or certify result quality.

Accepted Runs retain their resource versions and captured content. Later configuration or file changes do not rewrite that history. Resource discovery, native file reads, SDK expansion, provider delivery and following instructions are separate observations. Inspect the saved resource evidence and original Run before reporting successful use.

## Diagnose unavailable resources

Confirm the Host and Session, then inspect the exact version, required tools/extensions and diagnostic reason. Keep an invalid or missing resource visible as unavailable; do not replace its source or broaden permissions merely to remove a warning. For an active Run, inspect its original scope and snapshot instead of inferring historical availability from the current catalog.

See [architecture](../architecture/overview.md), [evaluation](../evaluation/overview.md) and the [UI rules](../ui/ui-system.md). Sources: [resource contracts and readiness](../../packages/contracts/src/resources.ts), [resource service](../../packages/core/src/resources/resource-service.ts), [input adaptation](../../packages/runtime-pi/src/input-adapter.ts), [Prompt optimizer](../../apps/desktop/src/renderer/prompt-workbench.tsx), [Skills UI](../../apps/desktop/src/renderer/resource-panel.tsx).
