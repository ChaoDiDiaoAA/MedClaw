// The precise-version patch owns this entry; the normal ambient extension is never loaded by the product.
import { createManagedAgentExtension, type ManagedAgentSessionBridge } from '@tintinweb/pi-subagents/managed';
export { createManagedAgentExtension };
export type { ManagedAgentSessionBridge, ManagedAgentExtension } from '@tintinweb/pi-subagents/managed';
import { wrapRegisteredTool, type AgentSession, type DefaultResourceLoader, type ExtensionFactory, type RegisteredTool } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { safeError } from '@medclaw/contracts/error';
import type { AnyToolDefinition, ToolExecutionContext } from '@medclaw/contracts/tool';
import { NativeAgentReplySchema, type ChildExecutionObservation, type CommittedChildResult } from '@medclaw/contracts/subagent';
import { nativeHistoryJSON } from './memory-store';
export const SUBAGENT_BUILD = Object.freeze({
  pluginVersion: '0.19.0' as const, pluginGitHead: '4f572eaa04c09d3dbc16e4a5f13a16b295e84e14' as const,
  pluginIntegrity: 'sha512-DZsU33Urfb9dhEsJmsmpx0dayIHMYUbxng6AA7B6+bIgspNcTckcSnQRsbrv+QCS7jVKYJTzHIT/j1SU2B/nVQ==',
  patchHash: 'e907f1007f766dee86568b66208e5a520a28a84477ee8e0112d4a307e1b57cd6',
});

const AgentInputSchema=z.strictObject({prompt:z.string().min(1).max(65536),description:z.string().min(1).max(256),
  subagent_type:z.literal('medclaw-audit').default('medclaw-audit'),run_in_background:z.literal(false).default(false)});

/** One managed extension per parent execution; only its original registered tool can open a child. */
export function createRunSubagent(input:{runId:number;sessionId:number;getSession():AgentSession|undefined;getMaxTurns():number;
  open(context:ToolExecutionContext,request:Parameters<ManagedAgentSessionBridge['openSession']>[0]):Promise<AgentSession>;
  settle(id:string):Promise<ChildExecutionObservation>;
  finish(observation:ChildExecutionObservation,reply:z.infer<typeof NativeAgentReplySchema>):CommittedChildResult;
  acknowledge(observation:ChildExecutionObservation,version:number):void;release(id:string):Promise<void>}) {
  let origin:ToolExecutionContext|undefined,id:string|undefined,registered:RegisteredTool|undefined,closed=false,released=false;
  const managed=createManagedAgentExtension({getMaxTurns:input.getMaxTurns,openSession:async request=>{
    if(!origin||id||closed)throw safeError('state_conflict');id=request.pluginAgentId;
    return input.open(origin,request);
  }});
  const factory:ExtensionFactory=pi=>managed.factory(new Proxy(pi,{get(target,key){
    if(key==='registerTool')return (definition:RegisteredTool['definition'])=>{
      if(definition.name!=='Agent')throw safeError('extension_conflict');target.registerTool(definition);
    };
    return ()=>{throw safeError('extension_conflict');};
  }}));
  const override:NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionsOverride']>=base=>{
    const extensions=base.extensions.filter(extension=>extension.tools.has('Agent'));
    if(base.errors.length||extensions.length!==1)throw safeError('extension_conflict');
    const extension=extensions[0]!;
    if(extension.tools.size!==1||extension.handlers.size||extension.commands.size||extension.flags.size||extension.shortcuts.size
      ||extension.messageRenderers.size||extension.entryRenderers?.size||extension.markdownTransformer)throw safeError('extension_conflict');
    registered=extension.tools.get('Agent')!;
    return {...base,extensions:extensions.map(item=>({...item,tools:new Map()}))};
  };
  const definitions:readonly AnyToolDefinition[]=[{name:'Agent',label:'Agent',description:'Delegate a foreground read-only verification with independent context.',
    version:SUBAGENT_BUILD.pluginVersion,effect:'READ',executionMode:'sequential',inputSchema:AgentInputSchema,outputSchema:NativeAgentReplySchema,
    execute:async (args,context)=>{
      if(closed||origin||context.runId!==input.runId||context.sessionId!==input.sessionId||context.delegationSource)throw safeError('state_conflict');
      context.checkActive?.();context.signal.throwIfAborted();
      const session=input.getSession();if(!registered||!session?.extensionRunner)throw safeError('extension_unavailable');
      origin=context;released=false;
      try {
        const original=await wrapRegisteredTool(registered,session.extensionRunner).execute(context.nativeToolCallId,args,context.signal);
        if(!id)throw safeError('state_conflict');
        await managed.control.waitForSettled(id);
        const observation=await input.settle(id);
        const reply=NativeAgentReplySchema.parse(JSON.parse(nativeHistoryJSON(original)));
        const committed=input.finish(observation,reply);
        input.acknowledge(observation,committed.result.storageVersion);
        await managed.control.release(id);released=true;
        await input.release(id);
        origin=undefined;id=undefined;
        if(committed.result.outcome!=='completed')throw observation.error??safeError('internal_error',undefined,{reason:'subagent_execution_failed'});
        return reply;
      }catch(error){
        // A registered child with an unconfirmed save or release still owns this execution.
        if(!id){origin=undefined;await managed.control.dispose();closed=true;}
        throw error;
      }
    }}];
  return {factory,override,definitions,
    cancel:()=>{if(id&&!released)managed.control.cancel(id);},
    close:async()=>{closed=true;if(origin)throw safeError('stop_unconfirmed');await managed.control.dispose();},
  };
}
