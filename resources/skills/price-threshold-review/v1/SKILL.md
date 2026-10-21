---
name: price-threshold-review
description: Apply an explicit price-change direction and absolute ratio threshold to saved events with evidence
---
# Review price changes against a threshold

## Workflow

1. Call `read_data_scope`. Confirm the requested interval, direction, comparison operator and nonnegative ratio threshold; clarify unspecified conditions rather than inventing a default.
2. Read `references/threshold-semantics.md` before translating a percent or explaining matches.
3. Check date and predecessor coverage with `check_data_coverage` and `requirePredecessor: true`. Call `query_device_changes` with `changeKind: field_changed`, `changeField: price`, the confirmed `direction` when requested and `threshold: { operator, value }`.
4. Use `read_query_page` for the saved Query. Preserve its actual ratio, delta and filter basis; do not relabel filtered matches as statistical outliers.
5. Use `list_query_evidence` and `read_query_evidence` for relevant records. Return the exact direction, ratio comparison, actual result count, Query/Evidence IDs and exclusions or unknowns.

## Boundaries

Threshold screening is a deterministic query, not anomaly detection, investment advice or an estimate of procurement impact.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
