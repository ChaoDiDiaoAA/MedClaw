---
name: data-scope-review
description: Review permitted batches, dates and predecessor relationships before deciding what MedClaw data can answer
---
# Review the available data scope

## Workflow

1. Call `read_data_scope` for the current consumed input. Keep its workspace context, permitted batch and Query identities, `referenceDate` and `timezone`; do not reuse another Session or input scope.
2. Read `references/scope-checklist.md` when explaining the available range or deciding whether the requested data is missing.
3. Use `list_batches` with `page` and `pageSize` to inspect the permitted batch list. Continue pagination before claiming the list is complete.
4. Use `read_batch` with an actual returned `batchId` for relevant dates and predecessor relationships. Do not broaden scope to look up a missing batch.
5. Answer with supported batch IDs, actual data dates, requested range and unresolved gaps. State which requested analyses need another capability; this review does not run a device query.

## Boundaries

A batch list describes accessible imported data, not worldwide coverage, device stock or regulatory completeness. Missing scope is not a zero count.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
