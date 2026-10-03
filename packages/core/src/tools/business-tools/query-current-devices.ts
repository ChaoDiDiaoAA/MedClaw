import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { QueryService } from '../../data/query-service';

export const createQueryCurrentDevicesTool = (dependencies: {
  queries: QueryService;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'query_current_devices',
    version: '1.0.0',
    label: 'Query current devices',
    description: 'Query and save device snapshot records and their evidence. exact_date supports a single calendar day; explicit dates take precedence over the frozen run reference date, and omitting time uses that reference date and timezone. exact_date fails if a requested scope has no batch on that day. as_of (latest snapshot) selects the latest allowed batch before the exclusive cutoff date for each data scope and fails only if no such batch exists; it is not cumulative history. Use the returned interpretation to report requestedDate, dataDates, requestedTime, referenceDate, timezone, snapshotMode, basis, status, quantity, unit, and isStale. The quantity counts snapshot records, not physical units or inventory; without a reliable stock quantity field, inventory quantity is unknown. When status is omitted, include all statuses. Do not sum counts across dates or batches as distinct devices, or infer identical device sets from equal counts. Report stale data dates and their counts while stating that the target-date quantity is unknown. Result pages read the original saved query.',
    inputSchema: schemas.query_current_devices.input,
    outputSchema: schemas.query_current_devices.output,
    effect: 'READ',
    executionMode: 'sequential',
    execute: async (input, context) => dependencies.queries.current(input, context),
  } satisfies ToolDefinition<BusinessToolInput<'query_current_devices'>, BusinessToolOutput<'query_current_devices'>>);
};
