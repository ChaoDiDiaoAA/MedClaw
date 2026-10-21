---
name: distributor-change-review
description: Review distributor field changes and source provenance without inferring commercial or legal relationships
---
# Review distributor changes

## Workflow

1. Call `read_data_scope`, retaining the consumed input identities and permitted batches.
2. Read `references/distributor-change-basis.md` before interpreting naming or relationship changes.
3. Check requested dates and predecessor coverage with `check_data_coverage` and `requirePredecessor: true`. Use `query_device_changes` with `changeKind: field_changed`, `changeField: distributor` and the requested interval.
4. Page the saved Query with `read_query_page`. Retain actual distributor old/new values, dates and batch comparison.
5. Use `list_query_evidence` and `read_source_metadata` for relevant Evidence IDs. Return the literal changes, Query ID, provenance and unresolved naming or coverage issues.

## Boundaries

A changed distributor string does not prove a contract, ownership transfer, exclusive authorization or change in regulatory responsibility.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
