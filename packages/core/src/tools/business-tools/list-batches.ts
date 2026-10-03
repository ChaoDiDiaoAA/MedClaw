import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { CatalogService } from '../../data/catalog-service';

export const createListBatchesTool = (dependencies: {
  catalog: CatalogService;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'list_batches',
    version: '1.0.0',
    label: 'List batches',
    description: 'List full-coverage batches within the frozen scope with pagination and an optional snapshot date range whose upper bound is exclusive.',
    inputSchema: schemas.list_batches.input,
    outputSchema: schemas.list_batches.output,
    effect: 'READ',
    executionMode: 'parallel',
    execute: async (input, context) => dependencies.catalog.listBatches(input, context),
  } satisfies ToolDefinition<BusinessToolInput<'list_batches'>, BusinessToolOutput<'list_batches'>>);
};
