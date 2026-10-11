import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { ProductResultDetailsSchema, ProductTurnInputSchema, type ProductTurnFact, type ProductTurnInput } from '../../contracts/src/intent';
import { RESOURCE_LIMITS } from '../../contracts/src/resources';
import { safeError } from '../../contracts/src/error';
import { PiMemoryAdapter, nativeHistoryJSON } from './memory-store';

/** Public SDK appends remain in one hold until the caller confirms the final transaction. */
export function appendProductTurn(manager:SessionManager,memory:PiMemoryAdapter,raw:ProductTurnInput):ProductTurnFact {
  const parsed=ProductTurnInputSchema.safeParse(raw);if(!parsed.success)throw safeError('invalid_argument');
  const input=parsed.data;
  if(new TextEncoder().encode(nativeHistoryJSON(input)).byteLength>RESOURCE_LIMITS.nativeBytes)throw safeError('invalid_argument');
  memory.beginProductTurn(input);
  let userEntryId:string|null=null,resultEntryId:string|null=null;
  if(input.mode==='program'||input.mode==='user_form') {
    userEntryId=manager.appendMessage({role:'user',content:[{type:'text',text:input.text}],timestamp:Date.parse(input.occurredAt)});
    const details=ProductResultDetailsSchema.parse({contract:'medclaw.product-result/v1',source:input.mode,runId:input.runId,
      inputId:input.inputId,decisionId:input.decisionId,kind:input.result.kind,queryIds:input.result.queryIds,missingSlots:input.result.missingSlots});
    resultEntryId=manager.appendCustomMessageEntry('medclaw-query-result',input.result.text,true,details);
  }
  const executionEntryId=manager.appendCustomEntry(input.mode==='user_form'?'medclaw-query-form-execution':'medclaw-intent-execution',input.execution);
  const conditionEntryId=input.adoptedContext?manager.appendCustomEntry('medclaw-query-context',input.adoptedContext):null;
  return {userEntryId,resultEntryId,executionEntryId,conditionEntryId,history:memory.freezeFinal(input.runId)};
}
