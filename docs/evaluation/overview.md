# Evaluation and result review

[简体中文](overview.zh-CN.md) · [Documentation index](../README.md) · [Detailed CLI reference](../../agent-eval/README.md)

## Architecture and evidence

Evaluation is independent of the chat configuration. A Case declares input, fixture, budget and expected checks; a Trial records one execution. The runner gathers product observations and artifacts, deterministic scorers check applicable facts, and an independently configured Judge handles applicable semantic scoring. Reports retain evidence and unresolved gaps rather than converting unavailable checks into passes.

The current primary `medclaw-agent-v1` dataset has 50 developer-visible, hand-authored synthetic cases and a declared ten-case Smoke subset. Synthetic facts and independent CSV/Decimal recomputation are distinct from production traces. The supplementary badcase dataset retains missing historical-source blockers; an engineered source fixture does not recover a deleted real issue record.

The [public behavior contracts](../architecture/behavior-contracts.md) are the product-source sections used by authoring verification. Case, Gold, source references, compiled checks and authoring review must remain consistent. A data review does not establish real model quality; `qualityRuns: NOT_RUN` must not be relabeled by running engineering checks.

## Configuration and execution

Use the existing examples [agent.example.json](../../agent-eval/configs/agent.example.json) and [environment.example](../../agent-eval/configs/environment.example) to prepare private `agent-eval/configs/agent.json` and `environment` files. Agent and Judge choices are separate from the desktop chat model. Keep actual secrets and private configuration out of Git.

```powershell
bun run eval:smoke -- --check
bun run eval:full -- --check
```

These commands inspect prerequisites and configuration. They do not establish a completed evaluation. After prerequisites are satisfied, `bun run eval:smoke` and `bun run eval:full` execute real configured work and can send material to providers and incur cost. Presets default to one Trial per Smoke Case and three per Full Case; use documented `--trials` settings when deliberately changing repetition.

Results are saved locally. Uploading an existing archive and synchronizing feedback are explicit operations, not implied by evaluation startup. For example, inspect `bun run eval:upload -- --help` before selecting a real execution to upload. The desktop **Evaluation** page uses independent evaluation facilities; it is not the same operation as sending a Chat message.

## Intent recognition evaluation

Review each layer of the [intent pipeline](../intent/overview.md): rule outcome; hierarchy and slots; entity and time grounding; clarification or unsupported response; adopted route; actual Query results and evidence. A well-formed classification can still be semantically wrong, and a correct label can still lack an executable capability.

Examples include `mc-v1-intent-resolve` and `mc-v1-intent-clarify-region`. Engineering tests cover schemas, bounded review and route behavior. Real evaluation of the fixed official 0.8B model must inspect actual requests and outcomes, including ambiguous expressions, explicit corrections and unsupported tasks. Metadata inspection does not measure semantic accuracy, and this documentation supplies no unmeasured accuracy rate.

## Agent and resource engineering checks

For [subagents](../agents/subagents.md), check the original parent call and child identities, role snapshots across edits, four owned children and fifth-call rejection, independent cancellation, shared budgets, required persistence and release. Confirm whether child output was returned, delivered to a later parent request and actually adopted; a configured role is not an execution result.

For [Prompt and Skills](../guides/prompts-and-skills.md), check the optimization's original Provider Run, unknown-result readback, cancellation and save recovery, and draft insertion without a Chat send. Verify each slash-command source and owner, readiness comparison basis, actual reads and provider delivery separately from instruction adherence. Real usefulness and prompt improvements require their own model trials.

Relevant engineering examples include [parallel runtime](../../tests/integration/p13-parallel-runtime.test.ts), [role snapshots](../../tests/integration/p13-role-run-freeze.test.ts), [desktop role workflows](../../tests/e2e/p13-subagent-roles.spec.ts) and [Prompt optimizer interactions](../../tests/e2e/p11-prompt-workbench.spec.ts). Use the stage-specific commands in [development](../development/contributing.md); passing fixtures do not change dataset or real-model quality conclusions.

## Reports and comparisons

Use saved Case/Trial and execution identities when locating originals. Inspect final facts, tool choices, arguments, source use, latency, recovery and unknown states separately. Repeated trials support success-rate, pass@k and variability analysis only under compatible conditions and with their actual denominators and gaps retained. Judge failure or required missing evidence can leave a result undecidable.

Historical engineering counts in the CLI README remain dated facts, not current release certification. Compare actual reports and configurations; do not infer causal improvement from a changed prompt or a better single answer.

## Engineering checks

```powershell
bun run test:eval
bun test agent-eval/tests/datasets
python agent-eval/scripts/verify-stage-one.py
python -O agent-eval/scripts/verify-stage-one.py
```

The default Python command independently verifies the primary authored data without calling a model. Supplementary historical-source verification still requires its genuine originals. The normal and optimized Python paths must retain the same checks. Relevant sources are the [dataset loader](../../agent-eval/src/datasets.ts), [independent verifier](../../agent-eval/scripts/verify-stage-one.py), [data-check recorder](../../agent-eval/scripts/record-data-checks.ts), and [dataset tests](../../agent-eval/tests/datasets).
