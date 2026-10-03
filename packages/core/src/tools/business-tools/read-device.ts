import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { CatalogService } from '../../data/catalog-service';

export const createReadDeviceTool = (dependencies: {
  catalog: CatalogService;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'read_device',
    version: '1.0.0',
    label: 'Read device',
    description: 'Read stable source identifiers for a permitted device and display its name from the latest snapshot within permitted batches.',
    inputSchema: schemas.read_device.input,
    outputSchema: schemas.read_device.output,
    effect: 'READ',
    executionMode: 'parallel',
    execute: async (input, context) => dependencies.catalog.readDevice(input.deviceId, context),
  } satisfies ToolDefinition<BusinessToolInput<'read_device'>, BusinessToolOutput<'read_device'>>);
};
