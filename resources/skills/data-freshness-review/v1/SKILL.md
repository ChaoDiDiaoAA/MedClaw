---
name: data-freshness-review
description: Compare a requested date with actual permitted snapshot dates and report staleness without inventing current facts
---
# Review data freshness

## Workflow

1. Call `read_data_scope`, retaining the consumed input reference date, timezone and permitted batches.
2. Read `references/freshness-checklist.md` before interpreting latest, current or stale.
3. Use `list_batches` with appropriate pagination to inspect actual available dates within scope. Do not limit the search to an absent target day and then claim no older data exists.
4. Use `read_batch` with returned batch IDs to verify relevant snapshot dates and predecessor relationships. Compare the actual available date with the user-requested date.
5. Answer with requested date, actual data date, known lag and scope limitations. State that later-day values and complete coverage remain unknown when not measured.

## Boundaries

This review does not query device records or certify continuous date coverage. Latest available data is not proof of current stock, price or status.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
