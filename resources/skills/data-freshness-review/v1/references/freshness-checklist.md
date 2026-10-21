# Review data freshness: interpretation checklist

- Resolve relative dates using the consumed input referenceDate and timezone, not an unrelated wall clock or previous conversation.
- Latest means latest among actually inspected permitted batches. Paginate before claiming a maximum date over the whole accessible scope.
- Use snapshot dates rather than import timestamps as the observation date. A recently imported historical snapshot is still historical data.
- State any measured lag with its two dates and assumptions. No access to later data is an unknown, not proof that the source stopped publishing.
- Batch availability does not prove continuous coverage or present-day device facts. Do not infer physical inventory, current price, status or regulatory validity from freshness alone.
