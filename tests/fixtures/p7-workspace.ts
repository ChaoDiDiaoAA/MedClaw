import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { Repositories } from '../../packages/storage/src/repositories';
import { SqliteCatalogStore } from '../../packages/storage/src/catalog-store';
import { SqliteToolStore } from '../../packages/storage/src/tool-store';
import { CatalogService } from '../../packages/core/src/data/catalog-service';
import { QueryService } from '../../packages/core/src/data/query-service';
import { CurrentQuerySchema, QueryParamsSchema } from '../../packages/contracts/src/query';
import { canonicalRequest } from '../../packages/contracts/src/run';

const at = '2026-10-04T00:00:00.000Z';

/** Saved SQLite facts used by read-only Host and transaction fault tests. */
export function seedWorkspaceQueries(db: Database) {
  const repos = new Repositories(db);
  repos.createSession({ expectedWorkspaceRevision: 0 }, 'create-a', 'native-a', at);
  db.query(`INSERT INTO imports(id,operation_ref,instance_id,state,preview_request_hash,preview_request_json,created_at,updated_at)
    VALUES(1,'import','host','imported','hash','{}',?,?)`).run(at, at);
  db.query(`INSERT INTO batches(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,
    expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at)
    VALUES(1,1,'scope','2026-10-04','浙江','material/v1','bundle','lock',?,'full','cohort',3,3,'[]','{}',1,NULL,1,?)`).run('a'.repeat(64), at);
  for (const id of [1, 2, 3]) {
    db.query(`INSERT INTO devices(id,source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at)
      VALUES(?,?,'bundle','submission','[]',?)`).run(id, `device-${id}`, at);
    db.query(`INSERT INTO snapshots(id,batch_id,device_id,device_name,region,price_cents,currency,unit,status,source_row_ref,source_refs_json,field_origins_json)
      VALUES(?,1,?,'器械','浙江',100,'CNY','台','active',?,'[]','{}')`).run(id, id, `row-${id}`);
  }
  repos.updateWorkspace({ batchIds: [1] }, 1, at);
  const scope = repos.freezeAgentScope(repos.readWorkspace(), []);
  db.query(`INSERT INTO runs(id,session_id,kind,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,config_json,scope_json,workspace_json,reference_date,timezone,created_at)
    VALUES(10,1,'agent','host','query-submit',1,'{"sessionId":1,"clientSequence":1}','running','answer','query','{"agent":{"nativeSessionId":"native-a"}}',?,'{}','2026-10-04','Asia/Shanghai',?)`).run(JSON.stringify(scope), at);
  const store = new SqliteToolStore(db), queries = new QueryService(new CatalogService(new SqliteCatalogStore(db)), store);
  const context = { sessionId: 1, runId: 10, inputId: null, source: 'user_form' as const, callRef: 'saved-current', scope,
    referenceDate: '2026-10-04', timezone: 'Asia/Shanghai', signal: new AbortController().signal };
  const params = CurrentQuerySchema.parse({ batchIds: [1], time: { start: '2026-10-04', endExclusive: '2026-10-05' } });
  const toolContext = { sessionId: 1, runId: 10, nativeToolCallId: 'saved-current', scope,
    referenceDate: '2026-10-04', timezone: 'Asia/Shanghai', signal: context.signal };
  const currentPage = queries.current(params, toolContext), secondPage = queries.current(params, { ...toolContext, nativeToolCallId: 'saved-second' });
  const current = store.readQuery(currentPage.queryId)!;

  // Legacy aggregate results may contain equal saved rows. Commit saved facts through
  // the real store; do not fabricate Host output or recompute the saved result on read.
  const aggregateParams = QueryParamsSchema.parse({ kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1], metric: 'count', groupBy: 'region' });
  const rows = [{ value: 4, region: '浙江' }, { region: '浙江', value: 4 }, { value: 7, region: '浙江' }];
  const resultHash = createHash('sha256').update(canonicalRequest({ kind: 'aggregate', params: aggregateParams, batchIds: [1], scopeDeviceIds: null, rows, calculationVersion: 'legacy/v1' })).digest('hex');
  const duplicate = store.commitQuery({ sessionId: 1, runId: 10, inputId: null, callRef: 'legacy-duplicates', kind: 'aggregate', params: aggregateParams,
    batchIds: [1], scopeDeviceIds: null, rows, snapshotIds: [], eventIds: [], warnings: [], calculationVersion: 'legacy/v1', resultHash, createdAt: at }, [],
    { ...context, callRef: 'legacy-duplicates' });
  db.query("UPDATE runs SET status='completed',ended_at=? WHERE id=10").run(at);
  return { repos, store, queries, context, current, secondQueryId: secondPage.queryId, evidenceId: currentPage.evidenceIds[0]!, secondEvidenceId: secondPage.evidenceIds[0]!, duplicate };
}
