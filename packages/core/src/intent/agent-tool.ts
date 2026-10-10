import { z } from 'zod';
import { IntentQueryStepInputSchema, IntentStepMetadataSchema, type IntentQueryStepInput, type IntentAgentStepResult } from '../../../contracts/src/intent';
import { QuerySummarySchema } from '../../../contracts/src/query';
import type { ToolDefinition, ToolExecutionContext } from '../../../contracts/src/tool';

export function createQueryIntentStepTool(execute: (input: IntentQueryStepInput, context: ToolExecutionContext) => Promise<IntentAgentStepResult>) {
  const outputSchema = z.union([QuerySummarySchema.extend({ stepId: z.string(), part: z.number().int().nonnegative() }),
    IntentStepMetadataSchema]);
  return {
    name: 'query_intent_step', version: '1.0.0', label: 'Query validated intent step',
    description: 'Execute one frozen intent task part by stepId and zero-based part. Parameters come from the saved route decision. FRESHNESS part 0 returns real batch metadata on the snapshot_date basis, without a Query or capture timestamp. Use read_query_page and evidence tools with returned query identities; complete every task part before answering. Do not invent step identities or change task conditions.',
    inputSchema: IntentQueryStepInputSchema, outputSchema, effect: 'READ', executionMode: 'sequential',
    execute: async (input, context) => {
      const result = await execute(input, context);
      if('batches' in result)return {stepId:input.stepId,part:0 as const,basis:'snapshot_date' as const,batches:result.batches};
      const record=result.query;
      const { rows, snapshotIds: _snapshots, eventIds: _events, ...summary } = record;
      return { ...summary, stepId: input.stepId, part: input.part, totalRows: rows.length };
    },
  } satisfies ToolDefinition<IntentQueryStepInput, z.infer<typeof outputSchema>>;
}
