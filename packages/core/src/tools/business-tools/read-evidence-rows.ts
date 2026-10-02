import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { EvidenceReader } from '../../evidence/evidence-reader';

export const createReadEvidenceRowsTool = (dependencies: {
  evidence: EvidenceReader;
}) => ({
  name: 'read_evidence_rows',
  version: '1.0.0',
  label: 'Read evidence rows',
  description: 'Read the original business snapshots referenced by evidence with pagination, preserving source row references and field provenance. Synthetic fields must not be treated as real market facts.',
  inputSchema: businessToolSchemas.read_evidence_rows.input,
  outputSchema: businessToolSchemas.read_evidence_rows.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, context) => dependencies.evidence.rows(input, context),
} satisfies ToolDefinition<BusinessToolInput<'read_evidence_rows'>, BusinessToolOutput<'read_evidence_rows'>>);
