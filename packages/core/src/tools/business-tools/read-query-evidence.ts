import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { EvidenceReader } from '../../evidence/evidence-reader';

export const createReadQueryEvidenceTool = (dependencies: {
  evidence: EvidenceReader;
}) => {
  const schemas = businessToolSchemas;
  return ({
    name: 'read_query_evidence',
    version: '1.0.0',
    label: 'Read query evidence',
    description: 'Read the frozen snapshot, change event, source row, version references from evidence in the current session.',
    inputSchema: schemas.read_query_evidence.input,
    outputSchema: schemas.read_query_evidence.output,
    effect: 'READ',
    executionMode: 'parallel',
    execute: async (input, context) => dependencies.evidence.read(input.evidenceId, context),
  } satisfies ToolDefinition<BusinessToolInput<'read_query_evidence'>, BusinessToolOutput<'read_query_evidence'>>);
};
