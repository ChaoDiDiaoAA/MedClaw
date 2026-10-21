---
name: device-detail-review
description: Separate a device identity from its dated snapshot and verify the saved query and source metadata
---
# Review device details and sources

## Workflow

1. Call `read_data_scope`. Resolve the requested identity with `resolve_device`, then read the confirmed `deviceId` with `read_device`; ask for clarification if it is ambiguous.
2. Read `references/device-detail-evidence.md` before combining identity fields, snapshot values and source claims.
3. Use an explicitly selected suitable Query when available and inspect it with `read_query`. Otherwise call `query_current_devices` with permitted `batchIds`, confirmed `deviceIds` and the requested date interpretation. For `exact_date`, use a single-day `time` from the requested date to the next calendar day; for `as_of`, state the cutoff at `time.endExclusive`. Do not send a multi-day exact-date current query or claim full date coverage without a coverage check.
4. Read the saved result with `read_query` and `read_query_page`, keeping its Query ID, actual parameters, warnings and snapshot dates. Page through results needed for the requested detail.
5. Use `list_query_evidence` for that Query, then `read_source_metadata` with actual returned `evidenceId` values. Return identity facts, dated values, source references and unresolved gaps separately.

## Boundaries

The necessary tools do not include a general coverage check. Do not certify a complete period; report the actual returned dates and warnings. Source metadata is provenance, not an independent legal verification.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
