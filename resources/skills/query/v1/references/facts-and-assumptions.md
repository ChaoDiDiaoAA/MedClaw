# Facts and assumptions

- Confirm the requested date against the frozen `referenceDate` and `timezone`. State actual data dates and staleness; a latest known snapshot is not evidence of the quantity on a later date.
- Identify the result basis: snapshot records, device identifiers deduplicated by scope, or change events. None establishes physical inventory without a trustworthy stock quantity field.
- Use saved tool results and their Query / Evidence identities for calculations. Model prose is interpretation and cannot replace the saved calculation.
- Keep unknown values unknown. Do not turn a missing field into zero, infer stock from a pricing unit, or silently narrow an unspecified status to active devices.
- State assumptions and missing evidence separately from program facts. When evidence is insufficient, explain what is missing and which available tool could resolve it.
- Resource selection, SDK discovery, actual reads, request delivery and instruction adherence are different facts. Claim only the evidence that was observed.
