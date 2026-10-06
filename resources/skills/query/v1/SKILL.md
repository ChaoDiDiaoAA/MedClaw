---
name: query
description: Query MedClaw device data and distinguish verified facts, assumptions, and missing evidence
---
# Query MedClaw data

1. Read `references/facts-and-assumptions.md` relative to this Skill directory when preparing an answer.
2. Call `read_data_scope` for the current consumed input. Keep its frozen workspace, batch and Query identities. Use `check_data_coverage` to verify the requested period before drawing conclusions.
3. For current device records, use `query_current_devices` when available. For changes, use `query_device_changes` when available. Use the existing resolution and filter tools when the request is ambiguous. If a needed tool is unavailable, report the missing capability; do not install or invent one.
4. Inspect saved results with `read_query` / `read_query_page` and their basis with `read_query_evidence` / `list_query_evidence` / `read_evidence_rows` as appropriate. Reuse an explicitly selected Query instead of substituting a new one without explaining it.
5. Report verified facts, assumptions and missing evidence separately. Cite the actual Query and Evidence IDs. Explain dates, counting basis, status, quantity and unit, and disclose stale or missing values.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. Reading this file does not execute scripts or register tools. A resource read or request receipt alone cannot prove the model followed the instructions.
