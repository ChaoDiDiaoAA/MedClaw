import { PositiveIdSchema } from "../../../contracts/src/error";
import type { PageInput, QueryContext, QueryStore } from "../../../contracts/src/query";
import { CatalogService, pageItems } from "../data/catalog-service";
import { QueryService } from "../data/query-service";

/** Reads submitted evidence and imported records; original files are never opened or regenerated. */
export class EvidenceReader {
  constructor(private readonly catalog: CatalogService, private readonly queries: QueryService, private readonly store: QueryStore) {}
  list(input: PageInput & { queryId: number }, context: QueryContext) {
    this.queries.read(input.queryId, context); return pageItems(this.store.listEvidence(input.queryId), input);
  }
  read(evidenceId: number, context: QueryContext) {
    this.catalog.assertContext(context); if (this.store.assertReadContext) this.store.assertReadContext(context); else this.store.assertContext(context);
    const evidence = this.store.readEvidence(PositiveIdSchema.parse(evidenceId));
    if (!evidence) throw new Error("access_denied");
    this.queries.read(evidence.queryId, context); this.catalog.batches(evidence.batchIds, context);
    this.catalog.snapshotReferences(evidence.snapshotIds, context);
    return structuredClone(evidence);
  }
  rows(input: PageInput & { evidenceId: number }, context: QueryContext) {
    const evidence = this.read(input.evidenceId, context);
    const page = pageItems(evidence.snapshotIds, input);
    return { ...page, items: this.catalog.snapshotRows(page.items, context) };
  }
  sources(input: PageInput & { evidenceId: number }, context: QueryContext) {
    const rows = this.rows(input, context);
    return { ...rows, items: rows.items.map(row => ({ snapshotId: row.id, sourceRowRef: row.sourceRowRef, sourceRefs: row.sourceRefs, fieldOrigins: row.fieldOrigins })) };
  }
  readQuery(queryId: number, context: QueryContext) {
    this.queries.read(queryId, context);
    return this.store.listEvidence(queryId).map(evidence => this.read(evidence.id, context));
  }
}
