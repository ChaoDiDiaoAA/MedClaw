# List devices for a manufacturer: interpretation checklist

- Manufacturer strings come from imported records. Similar names are not automatically one legal entity; obtain user clarification before merging them.
- The filter is exact against supported values. An empty result after a guessed spelling is not evidence that the manufacturer has no devices.
- State region, batches, requested time and actual snapshot dates. A scoped data set cannot establish worldwide manufacturer activity.
- Current exact-date queries accept one day only. A multi-day exact listing needs separate daily queries with their own IDs, or the existing program query route; never pass the full interval as one exact-date current query. As-of selection uses the cutoff and must disclose its actual observation date.
- Use read_query to retain the original parameters and warnings, and read_query_page to continue the same saved result.
- Report snapshot-record counts as such. Neither the number of rows nor deduplicated device IDs proves physical stock, active approval or a complete market catalog.
