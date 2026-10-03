import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { CatalogService } from '../../data/catalog-service';

export const createListFilterValuesTool = (dependencies: {
  catalog: CatalogService;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'list_filter_values',
    version: '1.0.0',
    label: 'List filter values',
    description: 'List non-null filter values that actually occur in the specified permitted batches, deduplicated, stably sorted, and paginated.',
    inputSchema: schemas.list_filter_values.input,
    outputSchema: schemas.list_filter_values.output,
    effect: 'READ',
    executionMode: 'parallel',
    execute: async (input, context) => dependencies.catalog.listFilterValues(input, context),
  } satisfies ToolDefinition<BusinessToolInput<'list_filter_values'>, BusinessToolOutput<'list_filter_values'>>);
};
