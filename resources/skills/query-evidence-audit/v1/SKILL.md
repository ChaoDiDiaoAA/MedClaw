---
name: query-evidence-audit
description: Inspect a selected saved query, its pages, evidence rows and source metadata without silently rerunning it
---
# Audit a saved query and its evidence

## Workflow

1. Call `read_data_scope` and identify the explicitly selected or user-supplied permitted Query ID. Ask which Query to inspect if the identity is unclear.
2. Read `references/query-audit-checklist.md` before assessing whether a claim is supported.
3. Use `read_query` to inspect actual parameters, warnings, calculation version, interpretation and creation time. Use `read_query_page` for the saved rows, keeping the original queryId.
4. Use `list_query_evidence`, then `read_query_evidence`, `read_evidence_rows` and `read_source_metadata` with actual related Evidence IDs as required. Keep pagination and ownership consistent.
5. Return verified facts, discrepancies, missing evidence and what was not inspected. Cite the original Query and Evidence IDs; propose a separate new query only if needed and do not silently replace the audited result.

## Boundaries

This audit reads persisted program evidence. It does not certify external truth, model adherence or data beyond the selected Query scope.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
