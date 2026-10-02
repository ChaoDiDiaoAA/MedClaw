import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { CatalogService } from '../../data/catalog-service';

export const createResolveDeviceTool = (dependencies: {
  catalog: CatalogService;
}) => ({
  name: 'resolve_device',
  version: '1.0.0',
  label: 'Resolve device',
  description: 'Find devices within the permitted scope using case-insensitive substring matching for names or case-insensitive exact matching for source and submission IDs. Ambiguous candidates are not automatically selected.',
  inputSchema: businessToolSchemas.resolve_device.input,
  outputSchema: businessToolSchemas.resolve_device.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, context) => dependencies.catalog.resolveDevice(input, context),
} satisfies ToolDefinition<BusinessToolInput<'resolve_device'>, BusinessToolOutput<'resolve_device'>>);
