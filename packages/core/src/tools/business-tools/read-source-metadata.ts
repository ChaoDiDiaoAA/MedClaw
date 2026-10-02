import { businessToolSchemas } from '@medclaw/contracts/business-tools';
import type { BusinessToolInput, BusinessToolOutput } from '@medclaw/contracts/business-tools';
import type { ToolDefinition } from '@medclaw/contracts/tool';
import type { EvidenceReader } from '../../evidence/evidence-reader';

export const createReadSourceMetadataTool = (dependencies: {
  evidence: EvidenceReader;
}) => ({
  name: 'read_source_metadata',
  version: '1.0.0',
  label: 'Read source metadata',
  description: 'Read source files, records, row numbers, hashes, and per-field public/synthetic/synthetic-derived provenance from evidence snapshots with pagination. Only read imported metadata; do not open arbitrary files or network resources.',
  inputSchema: businessToolSchemas.read_source_metadata.input,
  outputSchema: businessToolSchemas.read_source_metadata.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, context) => dependencies.evidence.sources(input, context),
} satisfies ToolDefinition<BusinessToolInput<'read_source_metadata'>, BusinessToolOutput<'read_source_metadata'>>);
