---
name: new-device-records
description: Review added change events with predecessor coverage and distinguish new data records from new approvals
---
# Review newly appearing device records

## Workflow

1. Call `read_data_scope` and confirm the intended interval and permitted batch scope.
2. Read `references/added-event-basis.md` before interpreting an added event.
3. Call `check_data_coverage` with the requested half-open interval and `requirePredecessor: true`. Treat missing dates or predecessor batches as a limitation before drawing an absence comparison.
4. Call `query_device_changes` with permitted batch IDs, that interval and `changeKind: added`. Page the same saved Query with `read_query_page`.
5. Use `list_query_evidence` and `read_query_evidence` to inspect the relevant Evidence. Report the Query and Evidence IDs, old/new batch basis, actual added records and unresolved coverage.

## Boundaries

Added means present in the compared data where the predecessor lacked the record. It does not mean a newly approved, launched, manufactured or clinically validated device.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
