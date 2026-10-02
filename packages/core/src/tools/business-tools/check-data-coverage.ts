import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { CatalogService } from '../../data/catalog-service';

export const createCheckDataCoverageTool = (dependencies: {
  catalog: CatalogService;
}) => ({
  name: 'check_data_coverage',
  version: '1.0.0',
  label: 'Check data coverage',
  description: 'Check whether permitted batches cover the date range; as_of checks the latest batch before the exclusive cutoff. When a predecessor is required, baseline batches are incomplete without invented predecessor IDs. Missing batches cannot be interpreted as zero results.',
  inputSchema: businessToolSchemas.check_data_coverage.input,
  outputSchema: businessToolSchemas.check_data_coverage.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, context) => dependencies.catalog.checkCoverage(input, context),
} satisfies ToolDefinition<BusinessToolInput<'check_data_coverage'>, BusinessToolOutput<'check_data_coverage'>>);
