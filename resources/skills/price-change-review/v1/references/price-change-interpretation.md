# Review device price changes: interpretation checklist

- Prices and deltaCents are stored in integer cents; preserve the returned currency and unit when formatting a human-readable amount.
- The returned ratio is distinct from the absolute-ratio threshold filter. Keep a null ratio unknown, especially when the old price is missing or zero.
- Read original snapshot rows through actual Evidence IDs to check unit and currency. Explain any mismatch rather than inventing conversion rates or pack sizes.
- Missing predecessor or date coverage limits the set of observable changes. No event does not prove a stable price over an unobserved period.
- Report the saved Query basis and page coverage. No price change proves sales volume, physical inventory, procurement value or market-wide price behavior.
