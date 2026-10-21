# Search current device records: interpretation checklist

- Filter values are literal supported values. Do not guess a manufacturer spelling, silently substitute a region or narrow status without the user request.
- Keep the intended date interval and snapshotMode in the query. Coverage gaps remain visible even if some rows can be returned.
- An exact-date current query accepts only `[date, next calendar day)`. For an explicitly requested multi-day listing, use separate permitted daily queries and retain each Query ID, or explain the existing program query route. An as-of query selects the latest available snapshot before `time.endExclusive`; it does not list every day in the interval.
- Read additional pages from the original queryId. Repeating the query to obtain another page can change the result basis and is unnecessary.
- Distinguish totalRows from rows displayed on the current page. If pagination is bounded or interrupted, explain what was actually inspected.
- Cite the saved Query ID and returned row information. The tools in this Skill do not by themselves prove original source rows, regulatory status or model adherence.
