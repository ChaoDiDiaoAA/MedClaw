import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { QueryService } from '../../data/query-service';

export const createReadQueryTool = (dependencies: {
  queries: QueryService;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'read_query',
    version: '1.0.0',
    label: 'Read query summary',
    description: 'Read the frozen query conditions, batches, version, total result row count, and interpretation of dates, counting basis, status, quantity, and freshness in the current session, without recalculating the query. Grouped result rows are not the device count.',
    inputSchema: schemas.read_query.input,
    outputSchema: schemas.read_query.output,
    effect: 'READ',
    executionMode: 'parallel',
    execute: async (input, context) => {
      const query = dependencies.queries.read(input.queryId, context);
      return {
        queryId: query.id,
        kind: query.kind,
        params: query.params,
        batchIds: query.batchIds,
        totalRows: query.rows.length,
        warnings: query.warnings,
        calculationVersion: query.calculationVersion,
        createdAt: query.createdAt,
        interpretation: query.interpretation,
      };
    },
  } satisfies ToolDefinition<BusinessToolInput<'read_query'>, BusinessToolOutput<'read_query'>>);
};
