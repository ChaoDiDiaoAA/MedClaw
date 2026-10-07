import type { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { FrozenChildConfigSchema, childScopeWithin, type FrozenChildConfig } from '../../contracts/src/subagent';
import { RunScopeSchema } from '../../contracts/src/run';
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
