import type { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { FrozenChildConfigSchema, ChildResultSchema, childScopeWithin, type FrozenChildConfig, type ChildResult } from '../../contracts/src/subagent';
import { RunScopeSchema, RunCleanupRecordSchema, canonicalRequest } from '../../contracts/src/run';
import { ToolSdkDeliverySchema } from '../../contracts/src/tool';
import { ContextSnapshotBodySchema } from '../../contracts/src/context';
import type { QueryRecord } from '../../contracts/src/query';
import { safeError } from '../../contracts/src/error';

/** Internal history/tool/context reads all validate the original frozen relation. */
export function readFrozenChild(db: Database, runId: number): FrozenChildConfig {
  try {
    const row = db.query<{ id: number; session_id: number; parent_run_id: number; origin_tool_call_id: number; instance_id: string; config_json: string; scope_json: string }, [number]>("SELECT * FROM runs WHERE id=? AND kind='child'").get(runId);
    if (!row) throw new Error('missing child');
    const frozen = FrozenChildConfigSchema.parse(JSON.parse(row.config_json).subagent);
    const parent = db.query<{ session_id: number; instance_id: string; scope_json: string }, [number]>("SELECT * FROM runs WHERE id=? AND kind='agent' AND parent_run_id IS NULL").get(frozen.parentRunId);
    const session = db.query<{ native_session_id: string; creation_request_json: string }, [number]>("SELECT * FROM sessions WHERE id=? AND kind='child'").get(frozen.childSessionId);
    const origin = db.query<{ native_tool_call_id: string; context_snapshot_id: number; input_id: number | null }, [number, number, number]>(`SELECT t.native_tool_call_id,t.context_snapshot_id,s.input_id FROM tool_calls t JOIN context_snapshots s ON s.id=t.context_snapshot_id
      WHERE t.id=? AND t.run_id=? AND t.session_id=? AND t.tool_name='Agent' AND s.run_id=t.run_id AND s.session_id=t.session_id`).get(frozen.originToolCallId, frozen.parentRunId, frozen.parentSessionId);
    const creation = session && JSON.parse(session.creation_request_json);
    if (row.id !== frozen.childRunId || row.session_id !== frozen.childSessionId || row.parent_run_id !== frozen.parentRunId
      || row.origin_tool_call_id !== frozen.originToolCallId || row.instance_id !== frozen.instanceId
      || !parent || parent.session_id !== frozen.parentSessionId || parent.instance_id !== frozen.instanceId
      || !session || session.native_session_id !== frozen.nativeSessionId || creation.parentRunId !== frozen.parentRunId
      || creation.originToolCallId !== frozen.originToolCallId || creation.pluginAgentId !== frozen.pluginAgentId
      || !origin || origin.native_tool_call_id !== frozen.originNativeToolCallId || origin.context_snapshot_id !== frozen.originSnapshotId
      || origin.input_id !== frozen.parentInputId || !isDeepStrictEqual(RunScopeSchema.parse(JSON.parse(row.scope_json)), frozen.scope)
      || !childScopeWithin(frozen.scope, RunScopeSchema.parse(JSON.parse(parent.scope_json)))) throw new Error('child relation mismatch');
    return frozen;
  } catch { throw safeError('storage_read_failed'); }
}

/** A committed result is readable by its original parent only after the real SDK receipt is saved. */
export function readDeliveredChild(db: Database, parentRunId: number, originToolCallId: number): ChildResult | null {
  try {
    const row=db.query<{id:number;status:string;child_result_json:string|null;cleanup_json:string|null},[number,number]>("SELECT * FROM runs WHERE kind='child' AND parent_run_id=? AND origin_tool_call_id=?").get(parentRunId,originToolCallId);
    if(!row?.child_result_json)return null;
    const frozen=readFrozenChild(db,row.id),result=ChildResultSchema.parse(JSON.parse(row.child_result_json));
    const cleanup=RunCleanupRecordSchema.parse(JSON.parse(row.cleanup_json!));
    const session=db.query<{storage_version:number;current_leaf_id:string|null;native_session_id:string},[number]>('SELECT * FROM sessions WHERE id=?').get(frozen.childSessionId);
    if(result.childRunId!==frozen.childRunId||result.childSessionId!==frozen.childSessionId||result.parentRunId!==parentRunId||result.originToolCallId!==originToolCallId
      ||result.pluginAgentId!==frozen.pluginAgentId||result.nativeSessionId!==frozen.nativeSessionId||row.status!==result.outcome
      ||session?.storage_version!==result.storageVersion||session.current_leaf_id!==result.finalLeafId||session.native_session_id!==result.nativeSessionId
      ||createHash('sha256').update(canonicalRequest(result.originalReply)).digest('hex')!==result.originalReplyHash)throw new Error('child result mismatch');
    if(!cleanup.stopConfirmed||!cleanup.requiredPersistenceComplete||!cleanup.resourcesReleased)return null;
    const origin=db.query<{status:string;result_json:string|null;delivery_json:string|null;native_tool_call_id:string},[number,number,number]>("SELECT * FROM tool_calls WHERE id=? AND run_id=? AND session_id=? AND tool_name='Agent'").get(originToolCallId,parentRunId,frozen.parentSessionId);
    if(origin?.status!=='succeeded'||!origin.delivery_json)return null;
    const delivery=JSON.parse(origin.delivery_json);
    if(delivery.contract!=='medclaw.tool-delivery/v1'||delivery.resultRecorded!==true||delivery.sdkReturned!==true||!delivery.nativeEntryId||delivery.error)return null;
    const receipt=ToolSdkDeliverySchema.parse(delivery.message);
    if(receipt.isError)return null;
    const entry=db.query<{entry_json:string},[number,number,string]>("SELECT entry_json FROM memories WHERE run_id=? AND session_id=? AND native_entry_id=? AND entry_type='message'").get(parentRunId,frozen.parentSessionId,delivery.nativeEntryId);
    if(receipt.toolCallId!==origin.native_tool_call_id||receipt.toolName!=='Agent'||!entry||!isDeepStrictEqual(JSON.parse(entry.entry_json).message,receipt)
      ||!isDeepStrictEqual(JSON.parse(origin.result_json!),result.originalReply))throw new Error('child delivery mismatch');
    return result;
  }catch{throw safeError('storage_read_failed');}
}

/** The two explicit delegation exceptions; callers still enforce the execution identity and business Scope. */
export function canReadRelatedQuery(db: Database, runId: number, sessionId: number, query: QueryRecord): boolean {
  const child=db.query<{id:number},[number]>("SELECT id FROM runs WHERE id=? AND kind='child'").get(runId);
  if(child){
    const frozen=readFrozenChild(db,runId);
    if(frozen.childSessionId!==sessionId)return false;
    if(query.sessionId===sessionId)return query.runId===runId;
    if(query.sessionId!==frozen.parentSessionId)return false;
    const row=db.query<{snapshot_json:string},[number,number,number]>('SELECT snapshot_json FROM context_snapshots WHERE id=? AND run_id=? AND session_id=?').get(frozen.originSnapshotId,frozen.parentRunId,frozen.parentSessionId);
    if(!row)throw safeError('storage_read_failed');
    const snapshot=ContextSnapshotBodySchema.parse(JSON.parse(row.snapshot_json));
    const hash=createHash('sha256').update(canonicalRequest(query)).digest('hex');
    return snapshot.selectedRefs.some(ref=>ref.kind==='query'&&ref.channel==='product_projection'&&ref.id===String(query.id)&&ref.version===query.resultHash&&ref.hash===hash);
  }
  const origin=db.query<{origin_tool_call_id:number},[number,number,number,number]>(`SELECT c.origin_tool_call_id FROM runs c JOIN runs p ON p.id=c.parent_run_id
    WHERE c.id=? AND c.session_id=? AND c.kind='child' AND p.id=? AND p.session_id=? AND p.kind='agent'`).get(query.runId,query.sessionId,runId,sessionId);
  if(!origin)return false;
  return readDeliveredChild(db,runId,origin.origin_tool_call_id)?.queryRefs.some(ref=>ref.queryId===query.id&&ref.resultHash===query.resultHash)??false;
}
