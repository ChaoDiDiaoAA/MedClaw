---
name: price-change-review
description: Review recorded price changes, units and original evidence while retaining null ratios and coverage gaps
---
# Review device price changes

## Workflow

1. Call `read_data_scope` and confirm the requested period, batch scope and any device filters.
2. Read `references/price-change-interpretation.md` before explaining delta, ratio, currency or unit.
3. Check date and predecessor coverage with `check_data_coverage` and `requirePredecessor: true`. Query `query_device_changes` with `changeKind: field_changed`, `changeField: price` and the requested interval.
4. Use `read_query_page` for the original Query. Keep returned old/new values, `deltaCents`, `ratio`, calculation basis and warnings; do not recompute missing ratios from assumptions.
5. Use `list_query_evidence` and `read_evidence_rows` for actual Evidence IDs when checking original snapshot prices, currency and unit. Return verified changes, Query/Evidence IDs and unresolved comparability separately.

## Boundaries

A pricing unit is not a stock quantity. Do not compare different currencies or units as if they were interchangeable, or call a price movement a statistical anomaly.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
