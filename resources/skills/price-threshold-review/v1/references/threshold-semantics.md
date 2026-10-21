# Review price changes against a threshold: interpretation checklist

- The threshold filter compares the absolute change ratio abs((new-old)/old). A user threshold of 10 percent is the ratio 0.10, not 10.
- Use direction increase or decrease separately when requested. Without direction, the absolute threshold can match moves in either direction.
- Operators gt, gte, lt and lte have different boundary behavior. Preserve the user comparison and ask if it is unclear.
- The existing filter requires a positive old price and a non-null new price. Excluded or null ratios are not zero changes and should not be invented as matches.
- State the saved interval, batches and predecessor gaps. Query results establish recorded matching events, not market-wide anomalies, future prices or economic losses.
