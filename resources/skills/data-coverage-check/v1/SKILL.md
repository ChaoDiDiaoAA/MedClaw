---
name: data-coverage-check
description: Check requested dates, snapshot mode and predecessor requirements while preserving unknown coverage as unknown
---
# Check data coverage

## Workflow

1. Call `read_data_scope` and retain the consumed input scope, `referenceDate` and `timezone`. Resolve a relative date against that reference before making a coverage claim.
2. Read `references/coverage-interpretation.md` before interpreting missing dates, as-of coverage or predecessor gaps.
3. Call `check_data_coverage` with the requested `time.start` and exclusive `time.endExclusive`, explicit `snapshotMode`, and the appropriate `requirePredecessor`. Do not substitute an easier interval.
4. Inspect returned `batchIds`, `missingDates`, `missingPredecessorBatchIds` and `complete`. Use `read_batch` for returned batches whose actual date or predecessor needs explanation.
5. Return the requested interval and mode, actual available dates, gaps and whether the proposed query can be supported. Ask for a scope or date clarification instead of converting an unsupported period to zero.

## Boundaries

Coverage checks do not create a business query. As-of data is a latest-known snapshot and must not be described as a measurement made on every requested date.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
