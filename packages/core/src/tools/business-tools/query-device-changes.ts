import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { QueryService } from '../../data/query-service';

export const createQueryDeviceChangesTool = (dependencies: {
  queries: QueryService;
}) => ({
  name: 'query_device_changes',
  version: '1.0.0',
  label: 'Query device changes',
  description: 'Query and save device additions, missing devices, or field changes within the date range, together with their evidence. Changes must reference allowed previous and subsequent batches. Prices are calculated in cents; the ratio is null when the previous price is zero. threshold compares the absolute price change ratio, where 1 means 100%.',
  inputSchema: businessToolSchemas.query_device_changes.input,
  outputSchema: businessToolSchemas.query_device_changes.output,
  effect: 'READ',
  executionMode: 'sequential',
  execute: async (input, context) => dependencies.queries.changes(input, context),
} satisfies ToolDefinition<BusinessToolInput<'query_device_changes'>, BusinessToolOutput<'query_device_changes'>>);
