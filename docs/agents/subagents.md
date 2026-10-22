# Read-only subagents

[简体中文](subagents.zh-CN.md) · [Documentation index](../README.md)

The main Agent can use the `Agent` tool to delegate independent, foreground, read-only work. Each child has its own Session, Run, native history and original parent ToolCall. The parent remains responsible for checking the result and producing the final answer. Registering a role or selecting a command does not itself prove that a child ran.

## Built-in roles

| Role | Intended work | Tool boundary |
| --- | --- | --- |
| `medclaw-audit` | Verify task materials, saved queries and evidence | Declared file-reading and business-reading tools, restricted to the parent's admitted scope |
| `general-analyst` | Independently analyze material explicitly supplied by the parent | `tools: []`; no file, business, shell or delegation tools |

A role declares instructions and tools, not a separate model or execution budget. Children use the parent's resolved model and controlled execution configuration. A declaration cannot grant a tool outside the allowed read-only set or the parent scope. Children cannot start another delegation. See the [public subagent contract](../architecture/behavior-contracts.md#read-only-subagents).

## Use from Chat

Configure the [main model](../guides/getting-started.md), select a confirmed user Session and the relevant data scope, then use an explicit input such as:

```text
/subagent general-analyst Check the assumptions in the following supplied analysis: ...
/medclaw-evidence-review Verify the evidence for this query and identify coverage gaps.
/parallel-medclaw-review Review the supplied analysis and its query evidence independently.
```

`/subagent <role-id> <task>` uses the registered command to prepare a named delegation request. The two named templates ask the main Agent to call `medclaw-audit`, or both `medclaw-audit` and `general-analyst`, respectively. These inputs are accepted as new Send operations; they cannot be queued as Steer or Follow-up. They use the delegation input path rather than local intent classification. A child is created only when the main Agent makes an actual `Agent` tool call; inspect the saved child facts to confirm execution. A template asking for two calls does not guarantee that a particular model will make them.

The slash menu separates **Skills**, **Subagents**, **Prompt Templates** and **Extension Commands**. Unavailable entries expose their reasons. See [Prompt and Skills](../guides/prompts-and-skills.md) for the different input types.

## Manage role files

Open **Extensions → Manage agents** with a confirmed user Session and a ready Host. **Edit agent**, **New agent** and **Save agent** manage role content. Editing a built-in role creates a user override. Built-ins live in the installation resource root's `subagents/`; user files live in `<dataRoot>/subagents/<role-id>.md`, separate from the source checkout.

A role uses strict frontmatter and a nonempty instruction body. For example:

```yaml
---
name: supplied-reviewer
description: Review only the material supplied by the parent.
tools: []
---
Identify assumptions and missing information. Do not claim to inspect external sources.
```

The file name must match the lowercase role ID. The accepted frontmatter fields are `name`, `description` and `tools`; model, cwd, background execution and other settings are not role options. Files are bounded to 64 KiB and the role catalog to 128 IDs. An invalid user override blocks that ID instead of silently falling back to the built-in role. Path, encoding, size and tool checks can make a role unavailable.

Saving compares the exact original content to prevent an outdated editor from replacing a newer revision. A conflict retains the draft; explicitly read the current role before replacing it. If a reply is lost, use **Verify agent save** to inspect the saved content before another save. Role content is captured when a Run is admitted: edits apply to subsequent Runs, while an accepted Run keeps its original snapshot. Old Runs without recorded role snapshots are not populated from today's files.

## Parallel work, budgets and stopping

At most four child executions may remain owned at a time. A fifth call is rejected as busy until a slot is released. A terminal child with an unconfirmed result save or cleanup still occupies its slot; this is not a four-child limit over the whole lifetime of a Run.

Parent and children share the root model-call budget and execution deadline. Independent histories do not give children independent unlimited budgets. Inspect the actual tool scope and remaining budget rather than assuming a role can always run.

Chat shows child task cards; **View Subagent Run** opens the original child's details. **Stop Subagent Run** requests cancellation of that child while its parent and siblings can continue. Stopping the parent requests cancellation of its children and retains root ownership until required stopping, saving and cleanup are confirmed. A cancellation request alone is not proof that execution stopped.

## Read results and limits

Inspect the original parent ToolCall, child identities, recorded role, result, evidence references, cleanup and parent receipt. A committed child result, an SDK return, verified delivery in a later parent model request and adoption in the final answer are separate facts. Read and verify referenced results before using them as answer evidence.

When [intent routing](../intent/overview.md) selects main-Agent execution, the parent may use a read-only helper. Validated query steps and final Answer ownership remain with the parent. Role instructions cannot change the accepted intent parameters, QueryContext or authorization.

Configured external models receive the material needed for their parent and child requests; local storage does not make these requests local inference. Engineering fixtures can verify ownership, parallel admission and cancellation, but they do not certify useful delegation or real model quality. See [evaluation](../evaluation/overview.md).

Sources: [role contracts](../../packages/contracts/src/subagent.ts), [role loading and saving](../../packages/runtime-pi/src/resource-loader.ts), [managed delegation](../../packages/runtime-pi/src/subagent-adapter.ts), [runtime ownership](../../packages/core/src/runtime/runtime-service.ts), [role management UI](../../apps/desktop/src/renderer/extensions-page.tsx).
