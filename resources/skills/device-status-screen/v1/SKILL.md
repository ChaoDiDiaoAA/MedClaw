---
name: device-status-screen
description: Filter device snapshots by an explicit business status and retain the actual query and source basis
---
# Screen device records by status

## Workflow

1. Call `read_data_scope` and confirm the requested status, dates and geographic scope.
2. Read `references/status-meaning.md` before translating an imported status into an explanation.
3. Inspect supported status values with `list_filter_values`; use only a supported explicit query status. Check coverage with `check_data_coverage`.
4. Call `query_current_devices` with the confirmed status, permitted batch IDs and requested date interpretation. For `exact_date`, `time` must cover only the requested date to the next calendar day; for `as_of`, state the cutoff at `time.endExclusive` and actual returned date. Do not send a multi-day exact-date current query. Continue with `read_query_page` for the same saved Query.
5. Use `list_query_evidence` and `read_source_metadata` for that Query as needed. Report the exact status, actual data dates, result basis, Query ID, source references and unknowns.

## Boundaries

Business status values do not constitute legal or regulatory determinations. Do not infer withdrawal, approval validity or clinical safety from a status label.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
