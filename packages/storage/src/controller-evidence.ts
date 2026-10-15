import type { Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { ControllerEvidenceInputSchema,ControllerEvidenceOutputSchema,ProviderRequestOriginalSchema,QueryInventoryOriginalSchema,type ControllerEvidenceInput } from '../../contracts/src/controller-evidence';
import type { SqliteMemoryStore } from './memory-store';
import type { SqliteToolStore } from './tool-store';
import { readFrozenChild } from './child-identity';
import { RunScopeSchema } from '../../contracts/src/run';
import {omitLegacyFields,legacyRunScope} from './legacy-business-fields';

/** Host-owned, identity-scoped original reads. There is deliberately no pathname input. */
export class ControllerEvidenceReader {
  constructor(private readonly db:Database,private readonly memory:SqliteMemoryStore,private readonly tools:SqliteToolStore,private readonly instanceId:string) {}
  read(raw:ControllerEvidenceInput) {
    const input=ControllerEvidenceInputSchema.parse(raw);
    if(input.expectedInstanceId!==this.instanceId)throw new Error('access_denied');
    return this.db.transaction(()=>{
      const owner=input.selector;
      if(owner.runId!==null&&!this.db.query('SELECT id FROM runs WHERE id=? AND session_id IS ? AND instance_id=?').get(owner.runId,owner.sessionId,input.ownerInstanceId))throw new Error('access_denied');
      let original:unknown;
      if(owner.kind==='request') {
        const row=this.db.query<{model_json:string},[string,number|null,number|null]>('SELECT model_json FROM model_calls WHERE call_id=? AND run_id IS ? AND session_id IS ?').get(owner.callId,owner.runId,owner.sessionId);
        if(!row)throw new Error('evidence_not_found');
        const originals=ProviderRequestOriginalSchema.array().parse((JSON.parse(row.model_json).requestOriginals??[]).map((item:unknown)=>omitLegacyFields(item,['sha256'])));
        if(!originals.length)throw new Error('evidence_not_found');
        originals.forEach((item,index)=>{if(item.instanceId!==input.ownerInstanceId||item.callId!==owner.callId||item.sessionId!==owner.sessionId||item.runId!==owner.runId||item.sequence!==index+1||Buffer.byteLength(item.body)!==item.bytes)throw new Error('evidence_integrity_failed');});
        original=originals;
      } else if(owner.kind==='run') {
        const row=this.db.query<{kind:string;scope_json:string;child_result_json:string|null},[number]>('SELECT kind,scope_json,child_result_json FROM runs WHERE id=?').get(owner.runId)!;
        original={instanceId:input.ownerInstanceId,runId:owner.runId,sessionId:owner.sessionId,scope:RunScopeSchema.parse(legacyRunScope(JSON.parse(row.scope_json))),child:row.kind==='child'?readFrozenChild(this.db,owner.runId):null};
      } else if(owner.kind==='history') {
        original=this.memory.loadInTransaction(owner.sessionId);
      } else if(owner.kind==='queries') {
        const queryIds=this.db.query<{id:number},[number,number]>('SELECT id FROM queries WHERE run_id=? AND session_id=? ORDER BY id').all(owner.runId,owner.sessionId).map(row=>row.id);
        original=QueryInventoryOriginalSchema.parse({instanceId:input.ownerInstanceId,runId:owner.runId,sessionId:owner.sessionId,queryIds});
      } else {original=this.tools.readControllerOriginal(owner.runId,owner.sessionId,owner.toolCallId);if(!original)throw new Error('evidence_not_found');}
      const bytes=Buffer.from(JSON.stringify(original),'utf8');
      if(input.offset>bytes.length)throw new Error('invalid_argument');
      const end=Math.min(bytes.length,input.offset+input.limit);
      const result=ControllerEvidenceOutputSchema.parse({instanceId:this.instanceId,ownerInstanceId:input.ownerInstanceId,selector:owner,bytes:bytes.length,offset:input.offset,nextOffset:end<bytes.length?end:null,encoding:'base64',data:bytes.subarray(input.offset,end).toString('base64')});
      if(!isDeepStrictEqual(result.selector,owner))throw new Error('access_denied');return result;
    }).deferred();
  }
}
