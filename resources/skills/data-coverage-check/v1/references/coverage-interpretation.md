# Check data coverage: interpretation checklist

- Time ranges are half-open: start is included and endExclusive is excluded. State the user-facing period without dropping its last requested day.
- Use exact_date when the question requires data observed on that date; explain any explicitly chosen as_of interpretation and actual snapshot date.
- Changes need predecessor evidence. Missing predecessor batches cannot be interpreted as zero changes or as a first appearance.
- Read complete together with the returned missing lists and batch IDs. It describes the requested coverage policy, not every possible business claim.
- An unavailable tool, denied batch or failed read is an unresolved check. Do not claim complete coverage based on the Skill text or on a previous Run.
