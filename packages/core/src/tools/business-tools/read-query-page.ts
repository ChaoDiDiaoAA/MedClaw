import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { QueryService } from '../../data/query-service';

export const createReadQueryPageTool = (dependencies: {
  queries: QueryService;
}) => ({
  name: 'read_query_page',
  version: '1.0.0',
  label: 'Read query result page',
  description: 'Read a page of the ordered results saved by the original query in the current session, without rerunning the query or changing its conditions.',
  inputSchema: businessToolSchemas.read_query_page.input,
  outputSchema: businessToolSchemas.read_query_page.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, context) => dependencies.queries.page(input, context),
} satisfies ToolDefinition<BusinessToolInput<'read_query_page'>, BusinessToolOutput<'read_query_page'>>);
