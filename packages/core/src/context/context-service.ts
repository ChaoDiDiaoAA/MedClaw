import { z } from 'zod';
import { AppErrorSchema, safeError, serviceResult, type Result } from '../../../contracts/src/error';
import { ContextProjectionSchema, CONTEXT_MATERIAL_PREFIX, type ContextStore, type PrepareContextInput, type PrepareChildContextInput, type SaveContextSelection, type RegisterContextDeliveryInput, type ReadContextInput, type ContextReadResult } from '../../../contracts/src/context';
import type { ManagedImportInspection } from '../../../contracts/src/workspace';
import type { PrepareIntentContextInput } from '../../../contracts/src/context';

export class ContextService {
  constructor(private readonly store: ContextStore, private readonly artifacts: {inspectManagedImport(id:number):Promise<ManagedImportInspection>}) {}
  prepare(input: PrepareContextInput) { return this.prepareSelection(input,()=>this.store.select(input)); }
  prepareChild(input: PrepareChildContextInput) {
    return this.prepareSelection(input,()=> { if(!this.store.selectChild)throw safeError('state_conflict'); return this.store.selectChild(input); });
  }
  prepareIntent(input: PrepareIntentContextInput) {
    return this.prepareSelection(input,()=> { if(!this.store.selectIntent)throw safeError('state_conflict'); return this.store.selectIntent(input); });
  }
  private async prepareSelection(input: PrepareContextInput | PrepareChildContextInput | PrepareIntentContextInput, select: () => SaveContextSelection) {
    const result = await serviceResult(async () => {
      const selection = select();
      const artifactIds = 'projection' in selection.input ? selection.input.scope.artifactIds
        : ContextProjectionSchema.parse(JSON.parse(selection.body.renderedProjection.slice(CONTEXT_MATERIAL_PREFIX.length))).materialScope.artifactIds;
      for (const id of artifactIds) {
        const inspection = await this.artifacts.inspectManagedImport(id);
        if (inspection.status === 'invalid') throw safeError('access_denied');
        if (inspection.status === 'unavailable') throw safeError(inspection.reason === 'storage_unavailable' ? 'storage_read_failed' : 'artifact_not_ready');
      }
      return this.store.save(selection);
    },'storage_write_failed',{runId:input.runId,sessionId:input.sessionId});
    if (!result.ok) throw result.error;
    return result.data;
  }
  recordDelivery(input: RegisterContextDeliveryInput) { return this.store.recordDelivery(input); }
  read(input: ReadContextInput): Result<ContextReadResult> {
    try { return {ok:true,data:this.store.read(input)}; }
    catch (error) {
      const known = AppErrorSchema.safeParse(error);
      const safe = safeError(known.success ? known.data.code : error instanceof z.ZodError ? 'invalid_argument' : error instanceof Error ? error.message : 'storage_read_failed');
      return {ok:false,error:safe.code === 'internal_error' ? safeError('storage_read_failed') : safe};
    }
  }
}
