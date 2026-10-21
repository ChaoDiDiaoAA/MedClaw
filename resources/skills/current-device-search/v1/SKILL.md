---
name: current-device-search
description: Search scoped device snapshots with verified filter values, date coverage and complete query pagination
---
# Search current device records

## Workflow

1. Call `read_data_scope` for the consumed input. Confirm requested dates, region and any identity filters without silently restricting to active records.
2. Read `references/current-search-basis.md` before choosing snapshot mode or describing a result count.
3. Use `list_filter_values` for supported textual filter fields and permitted `batchIds` when the value is uncertain. Check the requested interval with `check_data_coverage` using the intended snapshot mode.
4. Call `query_current_devices` using permitted batch IDs, resolved filters and the explicit requested date interpretation. For `snapshotMode: exact_date`, use a single-day `time` from that date to the next calendar day; for `as_of`, state the actual cutoff and returned snapshot dates. Do not pass a multi-day interval to an exact-date current query. Keep the returned Query identity and warnings.
5. Use `read_query_page` for additional pages of that saved Query. Return relevant rows, the actual total and paging limits, query basis and missing evidence. Do not invent Evidence IDs when only Query results were read.

## Boundaries

Search results are imported snapshot records within scope. A zero result under a filter does not prove universal absence, and record counts are not physical inventory.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
