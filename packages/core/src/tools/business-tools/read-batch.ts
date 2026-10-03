import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { CatalogService } from '../../data/catalog-service';

export const createReadBatchTool = (dependencies: {
  catalog: CatalogService;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'read_batch',
    version: '1.0.0',
    label: 'Read batch',
    description: 'Read the coverage, provenance, versions, and predecessor identity of one permitted batch.',
    inputSchema: schemas.read_batch.input,
    outputSchema: schemas.read_batch.output,
    effect: 'READ',
    executionMode: 'parallel',
    execute: async (input, context) => dependencies.catalog.readBatch(input.batchId, context),
  } satisfies ToolDefinition<BusinessToolInput<'read_batch'>, BusinessToolOutput<'read_batch'>>);
};
