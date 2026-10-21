---
name: missing-device-records
description: Review missing change events against available predecessor batches without inventing a withdrawal or stockout
---
# Review missing device records

## Workflow

1. Call `read_data_scope` and preserve the consumed input scope, dates and selected Query identities.
2. Read `references/missing-event-basis.md` before interpreting absence.
3. Check the requested interval with `check_data_coverage` and `requirePredecessor: true`. State incomplete coverage instead of treating it as no missing records.
4. Call `query_device_changes` with permitted batch IDs, the requested interval and `changeKind: missing`. Use `read_query_page` for remaining pages of that Query.
5. Use `list_query_evidence` and `read_query_evidence` for the returned Query. Report old/new batch comparisons, relevant events, Query and Evidence IDs, and what the data cannot establish.

## Boundaries

A missing event means absence from compared data, not a confirmed withdrawal, discontinuation, recall or physical stockout.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
