import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { EvidenceReader } from '../../evidence/evidence-reader';

export const createListQueryEvidenceTool = (dependencies: {
  evidence: EvidenceReader;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'list_query_evidence',
    version: '1.0.0',
    label: 'List query evidence',
    description: 'List saved evidence summaries for a query in the current session with pagination, preserving query, batch, and result hash associations.',
    inputSchema: schemas.list_query_evidence.input,
    outputSchema: schemas.list_query_evidence.output,
    effect: 'READ',
    executionMode: 'parallel',
    execute: async (input, context) => {
      const page = dependencies.evidence.list(input, context);
      return {
        ...page,
        items: page.items.map((item) => ({
          id: item.id,
          queryId: item.queryId,
          batchIds: item.batchIds,
          resultHash: item.resultHash,
          materialVersion: item.materialVersion,
        })),
      };
    },
  } satisfies ToolDefinition<BusinessToolInput<'list_query_evidence'>, BusinessToolOutput<'list_query_evidence'>>);
};
