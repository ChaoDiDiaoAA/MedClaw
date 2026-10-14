# MedClaw v1 shared fixtures

These files define reproducible input material, not expected answers. The fixture catalog maps Case `input.fixture.ref` values to regions, public file paths, declared absent paths, and controller-only files. The loader and import conversion live in `../dataset-fixtures.ts`, outside the data directories.

`procurement.csv` contains 24 explicitly fictional rows: six devices across Zhejiang and Henan, with snapshots on 2026-09-28, 2026-09-29, 2026-10-01 and 2026-10-02. Prices are integer CNY cents; `0` and `null` differ. No snapshot exists for September 30. Chinese business literals are retained to match the source. Author: MedClaw evaluation authoring; license: CC0-1.0; exposure: developer_visible. All cases share this synthetic source group, with no blind-holdout claim.

The CSV was hand-authored from these fictional business conditions. The import packages use direct field mapping; independent Python CSV/Decimal calculations verify truth. The material is not a capture of a real hospital or procurement API, so no real command or provider response is claimed. Folio's shared-file and safe-loading pattern is the reference; its CLI capture convention applies only to genuinely captured data.

| Profile | Prepared state |
|---|---|
| procurement | Both regions and the source CSV |
| zj-only | Zhejiang-only source and import packages |
| source-audit | Procurement, audit guidance and resource index |
| injected-guide | Procurement and audit guidance containing a quoted attack |
| missing-guide | Procurement; materials/legacy-price-guide.md must remain absent |
| private-canary | Procurement and public boundary note; synthetic marker under controller workRoot/private/credentials.txt |
| query-skill | Procurement and the actual installed query/v1 Session resource selection |
| query-timeout-once | Procurement and one trusted, recorded query tool timeout before business execution |
| compaction-history | Procurement and eight registered synthetic operations handoff turns between the initial task and manual compaction |

The source-audit text is input guidance, not an installed product Skill. History is created through each Case's registered prompt/turn actions; no unused seed history or fabricated SDK history is provided. The retry Case uses the controlled tool failure described below; the fixtures do not alter Provider responses.

Only the current prompt, workspace selection and public materials reach the Agent. Gold, future turns, scoring code, review records and controller-only files stay outside this projection. A canary checks observed leakage; local execution uses current account permissions and does not claim an OS sandbox.

Snapshots archive the actual catalog and input file contents. Changes invalidate the centralized data review and require independent verification. Dataset-owned versions remain v1/1, and archived data has no hashes.

`procurement-handoff.json` contains eight distinct fictional operations ledgers (receiving, invoices, storage, delivery, maintenance, qualification, reconciliation and escalation), with 72 unique records per ledger. Section and record identities, dates and synthetic owner references generate the records; they are CC0 authored synthetic material, not captured clinical data or procurement price truth. The compiler registers each current user turn through the real SDK; it never writes native history. Future handoff prompts are not placed in the public attachment index. SDK token estimation and the default 20,000-token retained tail establish a compressible prefix; actual execution must still prove a persisted compaction and later summary delivery. Preparation acknowledgements require no tools, but any tools the Agent chooses count toward the unchanged whole-Trial ceiling.

The controller verifies current public file contents and sends their logical references and absolute readable paths with each submission. Import protocol files and private canaries are excluded from this attachment index. A prepared file alone does not prove a model read: scoring checks native tool originals, SDK results and subsequent provider delivery. Missing-file declarations are checked before submission.

## Product resources and controlled failures

`query-skill` selects the installed `resources/skills/query/v1` through the product's Session resource settings. The loader captures `SKILL.md` and `references/facts-and-assumptions.md` as actual content in the snapshot; this directory does not maintain a second Skill copy. Selection, expansion/read, provider delivery and rule adoption are separate checks.

`query-timeout-once` requests the trusted Host scenario of the same name. After normal validation and admission, the first eligible current-query or intent-query call fails with `tool_timeout` before executing the business query. The failure and fresh retry use the normal tool recorder. The scenario is controller configuration, never Agent input.
