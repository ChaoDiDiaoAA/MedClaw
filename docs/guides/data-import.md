# Data import, queries and exports

[简体中文](data-import.zh-CN.md) · [Getting started](getting-started.md) · [Documentation index](../README.md)

## Accepted package

Business data is not distributed with this repository. The current importer accepts a flat CSV/JSON snapshot directory, not an arbitrary spreadsheet. Prepare Excel or other originals offline before creating a package that satisfies the [data contracts](../../packages/contracts/src/data.ts) and [import checks](../../packages/core/src/data/import-service.ts).

```text
snapshot-package/
├── manifest.json
├── zhejiang_YYYY-MM-DD.csv
├── zhejiang_YYYY-MM-DD.metadata.json
├── entity-lineage.csv
├── source-lock.json
├── adjustment-lineage.csv
├── validation-report.json
├── selection-report.json
└── 使用说明.md
```

Several business dates and their metadata files can be present; `README.md` is optional. The manifest declares payload paths and byte lengths, business file/byte/row counts and totals; its payload file list excludes the manifest itself. The importer checks the exact permitted flat file set, binding consistency, row identities, source references and dates. A matching filename alone does not prove a valid package.

Business CSV columns are:

```text
device_id,device_name,source_submission_id,source_applicant,category,region,snapshot_date,price_cents,currency,unit,status,manufacturer,distributor,source_refs_json,field_origins_json
```

Prices use integer cents and `CNY`; missing prices remain empty rather than becoming zero. Metadata, entity lineage, source registration, business rows and field origins must agree. Preserve public, simulated and derived field origins. Do not infer a canonical manufacturer from the source applicant merely because the names look related.

## Preview and commit

1. Select the directory through **Data Workspace → Choose snapshot directory**.
2. Review dates, regions, row/entity counts, duplicates and reported issues.
3. Use **Confirm import** only for the accepted preview; changed material is checked again by the import flow.
4. Select the batches to admit for subsequent work. Importing a file does not implicitly grant every Run access to every batch.

## Query semantics

Current records, change events, grouped aggregates and trends use different population and time semantics. Always inspect actual dates, scope, grouping, missing coverage, currency and units. Zero, a missing value and a missing snapshot remain different. A later snapshot cannot silently substitute for an earlier requested date, and a record count is not physical stock.

Use **Query History** to inspect saved results and their basis. Use explicit conditions or [intent recognition](../intent/overview.md) to establish the request; missing or ambiguous conditions may require clarification. Query and Evidence identities link results to saved source rows. See [the public query contract](../architecture/behavior-contracts.md#procurement-queries).

## Export and deletion

Use the saved Query's explicit export operation. The [export service](../../packages/core/src/data/export-service.ts) binds the original query and answer basis, including the complete supported result scope rather than the visible page. Generation, registration and destination copying have separate states; a generated artifact is not proof that copying completed. Automatic `EXPORT_RESULT` intent execution is currently disabled.

Data deletion is a separate explicit product operation. Review the selected target and resulting state; an unknown result is not permission to assume deletion or repeat it blindly. Keep private data, credentials and raw execution records out of source-control commits and review shared artifacts before sending them elsewhere.
