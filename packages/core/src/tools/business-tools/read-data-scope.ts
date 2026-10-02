import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { CatalogService } from '../../data/catalog-service';

export const createReadDataScopeTool = (dependencies: {
  catalog: CatalogService;
}) => ({
  name: 'read_data_scope',
  version: '1.0.0',
  label: 'Read data scope',
  description: 'Read the frozen data scope, reference date, and timezone for this run without expanding permissions or changing the workspace.',
  inputSchema: businessToolSchemas.read_data_scope.input,
  outputSchema: businessToolSchemas.read_data_scope.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, context) => dependencies.catalog.readScope(context),
} satisfies ToolDefinition<BusinessToolInput<'read_data_scope'>, BusinessToolOutput<'read_data_scope'>>);
