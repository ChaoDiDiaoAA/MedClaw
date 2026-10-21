# Review device details and sources: interpretation checklist

- Identity fields from read_device and time-dependent fields from a snapshot answer different questions. Label their origins and dates instead of merging them into an undated device profile.
- Read saved Query parameters and warnings before interpreting rows. Exact-date and as-of answers must state their actual observation basis.
- A current `exact_date` query accepts only `[date, next calendar day)`. Multi-day exact details need separate daily queries or the existing program query route rather than one multi-day current query. An `as_of` query returns the latest permitted snapshot before `time.endExclusive`, whose actual date must remain visible.
- List Evidence for the same Query before reading source metadata. Use real IDs and returned sourceRefs or fieldOrigins; do not invent source citations.
- Manufacturer, distributor, business status and price may vary by snapshot or source. Report conflicting or missing values explicitly.
- No returned quantity field establishes physical inventory, and a pricing unit is not stock. Do not infer approval, withdrawal or clinical suitability from these records.
