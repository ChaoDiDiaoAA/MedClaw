import { PositiveIdSchema,OpaqueIdSchema,safeError,serviceResult } from "../../../contracts/src/error";
import type { SessionStore } from '../../../contracts/src/session';
import type { Evidence, PageInput, QueryContext, QueryRecord, QueryStore } from "../../../contracts/src/query";
import { canonicalRequest } from '../../../contracts/src/run';
import { CatalogService, pageItems } from "../data/catalog-service";
import { QueryService } from "../data/query-service";

/** Reads submitted evidence and imported records; original files are never opened or regenerated. */
export class EvidenceReader {
  constructor(private readonly catalog: CatalogService, private readonly queries: QueryService, private readonly store: QueryStore,
    private readonly checkpoints?:Pick<SessionStore,'readCheckpointOperation'|'readSession'>) {}
  readCheckpointOperation(input:{operationRef:string}) {
    return serviceResult(()=>{OpaqueIdSchema.parse(input.operationRef);if(!this.checkpoints)throw safeError('storage_read_failed');
      const saved=this.checkpoints.readCheckpointOperation(input.operationRef);if(!saved)return null;
      const session=this.checkpoints.readSession(saved.receipt.sessionId);if(!session||session.kind!=='user')throw safeError('access_denied');return saved.receipt;
    },'storage_read_failed',{operationRef:input.operationRef});
  }
  list(input: PageInput & { queryId: number }, context: QueryContext) {
    const query = this.queries.read(input.queryId, context);
    const rows = this.store.listEvidence(input.queryId);
    if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => row.queryId !== query.id || row.resultHash !== query.resultHash
      || row.calculationVersion !== query.calculationVersion)) throw new Error('tool_output_inconsistent');
    const page = pageItems(rows, input);
    for (const evidence of page.items) this.validate(evidence, query, context);
    this.catalog.checkActive(context);
    return page;
  }
  read(evidenceId: number, context: QueryContext) {
    this.catalog.assertContext(context); if (this.store.assertReadContext) this.store.assertReadContext(context); else this.store.assertContext(context);
    const evidence = this.store.readEvidence(PositiveIdSchema.parse(evidenceId));
    if (!evidence) throw new Error("access_denied");
    if (evidence.id !== evidenceId) throw new Error('tool_output_inconsistent');
    this.validate(evidence, this.queries.read(evidence.queryId, context), context);
    return structuredClone(evidence);
  }
  private validate(evidence: Evidence, query: QueryRecord, context: QueryContext): void {
    const batches = this.catalog.batches(evidence.batchIds, context);
    const snapshots = new Set(query.snapshotIds), events = new Set(query.eventIds);
    if (evidence.queryId !== query.id || evidence.resultHash !== query.resultHash || evidence.calculationVersion !== query.calculationVersion
      || evidence.batchIds.some(id => !query.batchIds.includes(id)) || evidence.snapshotIds.some(id => !snapshots.has(id)) || evidence.eventIds.some(id => !events.has(id))
      || new Set(evidence.snapshotIds).size !== evidence.snapshotIds.length || new Set(evidence.eventIds).size !== evidence.eventIds.length
      || new Set(evidence.sourceRowRefs).size !== evidence.sourceRowRefs.length
      || evidence.filters !== undefined && canonicalRequest(evidence.filters) !== canonicalRequest(query.params)
      || batches.some(batch => batch.materialVersion !== evidence.materialVersion || batch.sourceBundleId !== evidence.sourceBundleId || batch.sourceLockHash !== evidence.sourceLockHash))
      throw new Error('tool_output_inconsistent');
    this.catalog.checkActive(context);
  }
  rows(input: PageInput & { evidenceId: number }, context: QueryContext) {
    const evidence = this.read(input.evidenceId, context);
    const page = pageItems(evidence.snapshotIds, input);
    const items = this.catalog.snapshotRows(page.items, context);
    if (items.some(row => !evidence.batchIds.includes(row.batchId) || !evidence.sourceRowRefs.includes(row.sourceRowRef))) throw new Error('tool_output_inconsistent');
    this.catalog.checkActive(context);
    return { ...page, items };
  }
  sources(input: PageInput & { evidenceId: number }, context: QueryContext) {
    const rows = this.rows(input, context);
    return { ...rows, items: rows.items.map(row => ({ snapshotId: row.id, sourceRowRef: row.sourceRowRef, sourceRefs: row.sourceRefs, fieldOrigins: row.fieldOrigins })) };
  }
  readQuery(queryId: number, context: QueryContext) {
    const query = this.queries.read(queryId, context);
    const rows = this.store.listEvidence(queryId);
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('tool_output_inconsistent');
    for (const evidence of rows) this.validate(evidence, query, context);
    return structuredClone(rows);
  }
}
