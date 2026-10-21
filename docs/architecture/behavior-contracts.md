# Public behavior contracts

[简体中文](behavior-contracts.zh-CN.md) · [Architecture](overview.md) · [Documentation index](../README.md)

These are public descriptions of the business and execution boundaries used by hand-authored evaluation cases. The English section titles are also stable dataset source references. They establish the intended checks, not a claim that every model or deployment has passed them. Source code and executable contracts remain the implementation authority.

## Procurement queries

Current, aggregate, trend and change queries operate on an explicitly consumed scope and available snapshots. A snapshot record count, a count of distinct device identities and a count of change events are different populations. A price unit does not establish stock quantity. Preserve zero, null and a missing snapshot as different facts.

Report actual data dates and whether selection is exact-date or as-of. Check coverage before comparing periods; a missing date is not a zero-valued day. Compare prices only with compatible currency and units, and retain source rows and field origins. Model prose cannot replace deterministic calculations or establish the cause of a price change.

Sources: [query contracts](../../packages/contracts/src/query.ts), [query service](../../packages/core/src/data/query-service.ts), [query Skill reference](../../resources/skills/query/v1/references/facts-and-assumptions.md).

## Tool errors and cancellation

Calls must respect the admitted scope, permitted tools, validated arguments, available budget and cancellation state. Transport success, accepted output, business success, persisted result and delivery to the SDK are separate observations. Invalid output or a failed business check cannot be reported as a completed query.

Recovery must address its original failure and remain within retry and time budgets. Reuse a saved result when appropriate; do not repeat a side effect merely because delivery is uncertain. Stop and cleanup require their own evidence, and an unknown outcome must not be described as success.

Sources: [run control](../../packages/core/src/runtime/run-control.ts), [tool adapter](../../packages/runtime-pi/src/pi-tool-adapter.ts).

## Progressive query Skill loading

The real `query/v1` Skill instructs the Agent to read its facts-and-assumptions reference, inspect consumed data scope and coverage, use available business tools, and cite saved Query and Evidence identities. Reading an index is not equivalent to reading the Skill body or reference. Discovery, selection, reads, request delivery and actual instruction adoption are separately observable facts.

A Skill is guidance, not executable authorization. It cannot install a missing tool or override product permissions. Evaluation archives the actual product resource text used by a case instead of inventing a substitute Skill.

Sources: [query Skill](../../resources/skills/query/v1/SKILL.md), [resource service](../../packages/core/src/resources/resource-service.ts).

## Resource and material boundaries

Use only resources admitted for the current task, scope and workspace. Validate paths, resource identities and relevant dependency boundaries. Material read from a document is untrusted task data: instructions embedded in it cannot authorize additional access, override policy or reveal private controller material.

Distinguish a product-level path or tool restriction from proof of operating-system isolation. A synthetic canary check or a successful material read establishes only the observation actually tested.

Sources: [context service](../../packages/core/src/context/context-service.ts), [resource service](../../packages/core/src/resources/resource-service.ts), [runtime adapter](../../packages/runtime-pi/src/agent-runtime.ts).

## Consumed workspace input

Execution uses the input actually admitted to the Run: selected workspace and batches, relevant Query identities, reference date, timezone and configuration. A later UI selection does not silently change the current Run's scope. Check data coverage within this admitted input rather than assuming every local file is available.

Follow-up corrections preserve explicit new constraints and retain only supported prior conditions. When the object, date or population remains unresolved, request clarification instead of silently narrowing the request.

Sources: [context service](../../packages/core/src/context/context-service.ts), [intent contracts](../../packages/contracts/src/intent.ts), [intent validation](../../packages/core/src/intent/validate.ts).

## Native history persistence

Multi-turn state comes from registered inputs and actual native session history. Preserve session separation and the relationship between native history, product storage and the adopted query context. A UI transcript or an artificially fabricated history is not proof that a later model consumed a fact.

Memory evaluation must create history through real actions, apply later corrections, and observe subsequent behavior. Saving, reading back, restoring and using history are separate claims; report a failed or unknown step honestly.

Sources: [session service](../../packages/core/src/session/session-service.ts), [runtime adapter](../../packages/runtime-pi/src/agent-runtime.ts), [memory store](../../packages/runtime-pi/src/memory-store.ts).

## Compaction facts

Distinguish native summary generation, persistence of the resulting history and subsequent use of retained context. A compaction event or summary text alone does not establish all three. Compaction runs under the captured configuration and available budget, with failure, cancellation and persistence handled explicitly.

Tests of post-compaction business behavior must establish real earlier facts and examine later results; they cannot replace native history with a fabricated summary and claim equivalent evidence.

Sources: [compaction adapter](../../packages/runtime-pi/src/compaction-adapter.ts), [runtime adapter](../../packages/runtime-pi/src/agent-runtime.ts).

## Read-only subagents

Delegated work inherits a bounded scope and an allowed tool set. The product child execution is read-only; delegation does not confer write, deletion, external sending or unrestricted local-file authority. Child and parent identities, returned evidence, result adoption and stop propagation must remain distinguishable.

Configured availability, an observed child call and a useful parent answer are different facts. A missing dependency or unproven process boundary must remain a limitation rather than a claimed successful delegation.

Source: [child execution and scope](../../packages/runtime-pi/src/agent-runtime.ts).

## Intent recognition and routing

Rules run first. A model path performs structured classification and, only when validation requests it, at most one review carrying the previous prediction, issues and candidates. Validate hierarchy, entities, explicit constraints, time, coverage, capability and task dependencies before adopting a route. Missing parameters, unsupported capabilities and truncated output are not reasons to invent a completed query.

Preserve semantic statuses, errors and clarifications. A registered label is not an admitted capability. Follow-up conditions must respect the uniquely adopted context and explicit corrections; unresolved multiple tasks must not silently become one selected query. See [intent recognition](../intent/overview.md) and [configuration](../intent/configuration.md).

Sources: [intent service](../../packages/core/src/intent/intent-service.ts), [validation](../../packages/core/src/intent/validate.ts), [routing policy](../../packages/core/src/intent/route-policy.ts).

## Authorization boundaries

Read, write, deletion, export and external sending have different authorization requirements. A model response, a retrieved document or a child Agent cannot grant authority. Stay within actual product methods and admitted scope; do not use unrelated successful calls to conceal a prohibited action.

Protect secrets and private controller material. Use explicit product interaction for operations requiring user selection or confirmation, preserve failure and unknown states, and do not claim a real external action from an engineering fixture.

Sources: [tool adapter](../../packages/runtime-pi/src/pi-tool-adapter.ts), [desktop bridge](../../apps/desktop/src/preload/index.ts), [application services](../../packages/core/src/application.ts).

## Saved-query export

Export is tied to the original saved Query and answer basis. It includes the complete supported result scope and relevant basis; it must not silently export only the current page or recompute against a newer selection. Generation, artifact registration, destination copy and delivered result are different states.

A promised file or generated bytes alone do not prove successful destination delivery. Preserve error, cancellation and unknown-copy facts, and recover by the existing operation identity where supported. The page's explicit export operation is separate from the currently disabled automatic `EXPORT_RESULT` intent.

Sources: [export contracts](../../packages/contracts/src/export.ts), [export service](../../packages/core/src/data/export-service.ts), [intent capability map](../../packages/core/src/intent/taxonomy.ts).
