---
name: manufacturer-device-list
description: Confirm a manufacturer filter and list scoped device records with their saved query basis
---
# List devices for a manufacturer

## Workflow

1. Call `read_data_scope`, keeping the current permitted batch IDs and date reference.
2. Read `references/manufacturer-list-basis.md` before interpreting manufacturer names and list totals.
3. Use `list_filter_values` with `field: manufacturer` and permitted batch IDs to confirm the exact value, reading relevant pages. Ask when multiple manufacturer names plausibly match.
4. Check the requested time range with `check_data_coverage`, then call `query_current_devices` with the confirmed manufacturer and explicit date or snapshot mode. An `exact_date` current query must use a single-day `time` from that date to the next calendar day; `as_of` uses the latest available snapshot before `time.endExclusive`. Do not add an unrequested status or send a multi-day exact-date current query.
5. Use `read_query` and `read_query_page` for the saved Query. Report the manufacturer literal, query conditions, actual dates, totalRows, relevant rows and warnings.

## Boundaries

A manufacturer-filtered row list is not a comprehensive product portfolio or regulatory registry. Deduplication by device identity must be labeled and must not be inferred from page length.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
