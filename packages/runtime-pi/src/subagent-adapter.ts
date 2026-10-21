// The precise-version patch owns this entry; the normal ambient extension is never loaded by the product.
import { createManagedAgentExtension, type ManagedAgentSessionBridge } from '@tintinweb/pi-subagents/managed';
export { createManagedAgentExtension };
export type { ManagedAgentSessionBridge, ManagedAgentExtension } from '@tintinweb/pi-subagents/managed';
import { wrapRegisteredTool, type AgentSession, type DefaultResourceLoader, type ExtensionFactory, type RegisteredTool, type RegisteredCommand, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { AppErrorSchema, safeError, type AppError } from '@medclaw/contracts/error';
import type { AnyToolDefinition, ToolExecutionContext } from '@medclaw/contracts/tool';
import { NativeAgentReplySchema, type ChildExecutionObservation, type CommittedChildResult } from '@medclaw/contracts/subagent';
import { nativeHistoryJSON } from './memory-store';
import { ExtensionOwnerSchema, type ExtensionOwner } from '@medclaw/contracts/extensions';
export const SUBAGENT_BUILD = Object.freeze({
  pluginVersion: '0.19.0' as const, pluginGitHead: '4f572eaa04c09d3dbc16e4a5f13a16b295e84e14' as const,
  pluginIntegrity: 'sha512-DZsU33Urfb9dhEsJmsmpx0dayIHMYUbxng6AA7B6+bIgspNcTckcSnQRsbrv+QCS7jVKYJTzHIT/j1SU2B/nVQ==',
  patchRevision: 'medclaw-managed/2026-10-21' as const,
});

const AgentInputSchema=z.strictObject({prompt:z.string().min(1).max(65536),description:z.string().min(1).max(256),
  subagent_type:z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).default('medclaw-audit'),run_in_background:z.literal(false).default(false)});

/** One managed extension per parent execution; only its original registered tool can open a child. */
export function createRunSubagent(input:{runId:number;sessionId:number;owner?:ExtensionOwner;getSession():AgentSession|undefined;getMaxTurns():number;
  verifyRole?(roleId:string):void;
  open(context:ToolExecutionContext,request:Parameters<ManagedAgentSessionBridge['openSession']>[0]):Promise<AgentSession>;
  settle(id:string):Promise<ChildExecutionObservation|null>;
  finish(observation:ChildExecutionObservation,reply:z.infer<typeof NativeAgentReplySchema>):CommittedChildResult;
  acknowledge(observation:ChildExecutionObservation,version:number):void;release(id:string):Promise<void>;fatal(error:AppError):void}) {
  type Invocation={origin:ToolExecutionContext;roleId:string;id?:string;released:boolean;running:boolean;
    observation?:ChildExecutionObservation;reply?:z.infer<typeof NativeAgentReplySchema>;openError?:unknown;committed?:CommittedChildResult};
  const invocations=new Map<string,Invocation>();
  type CommandReceipt={owner:ExtensionOwner;operationRef:string;inputId:number;roleId:string;task:string;name:'subagent';kind:'command';dispatchText:string};
  type PendingCommand={inputId:number;operationRef:string;roleId:string;task:string;receipt?:CommandReceipt;error?:AppError};
  let registered:RegisteredTool|undefined,registeredCommand:RegisteredCommand|undefined,closed=false,retrying:Promise<void>|undefined;
  let pendingCommand:PendingCommand|undefined;
  const managed=createManagedAgentExtension({getMaxTurns:input.getMaxTurns,onCommand:request=>{
    const pending=pendingCommand;
    try {
      if(closed||!pending||!input.owner||pending.receipt)throw safeError('state_conflict');
      if(request.roleId!==pending.roleId||request.task!==pending.task)throw safeError('extension_command_failed');
      input.verifyRole?.(request.roleId);
      pending.receipt={owner:structuredClone(input.owner),operationRef:pending.operationRef,inputId:pending.inputId,
        ...request,name:'subagent',kind:'command',dispatchText:`Use the Agent tool to delegate this foreground read-only task to role "${request.roleId}". Do not substitute another role.\n\nTask:\n${request.task}`};
    }catch(error){const known=AppErrorSchema.safeParse(error);if(pending)pending.error=known.success?known.data:safeError('extension_command_failed',error);throw error;}
  },openSession:async request=>{
    const invocation=invocations.get(request.nativeToolCallId);
    if(!invocation||invocation.id||closed||request.roleId!==invocation.roleId)throw safeError('state_conflict');
    invocation.id=request.pluginAgentId;
    try{return await input.open(invocation.origin,request);}catch(error){invocation.openError=error;throw error;}
  }});
  const persist=async(invocation:Invocation)=>{
    const {id,reply}=invocation;
    if(!id||!reply)throw safeError('state_conflict');
    const record=!invocation.released?await managed.control.waitForSettled(id):null;
    const settled=invocation.observation??await input.settle(id);
    if(!settled){
      await managed.control.release(id);invocation.released=true;invocations.delete(invocation.origin.nativeToolCallId);
      throw invocation.openError??safeError('internal_error',undefined,{reason:'subagent_binding_failed'});
    }
    invocation.observation??=settled;
    if(record&&record.status!=='completed'&&invocation.observation.error===null)invocation.observation={...invocation.observation,error:['aborted','stopped'].includes(record.status)?safeError('tool_cancelled'):safeError('internal_error',undefined,{reason:'subagent_execution_failed'})};
    try{invocation.committed??=input.finish(invocation.observation,reply);}
    catch(error){const known=AppErrorSchema.safeParse(error);if(known.success&&!invocation.observation.cleanup.secondaryErrors.some(item=>item.code===known.data.code))invocation.observation.cleanup.secondaryErrors.push(known.data);
      throw safeError('storage_write_failed',error);}
    input.acknowledge(invocation.observation,invocation.committed.result.storageVersion);
    if(!invocation.released){await managed.control.release(id);invocation.released=true;}
    await input.release(id);
    invocations.delete(invocation.origin.nativeToolCallId);
    return invocation.committed;
  };
  const factory:ExtensionFactory=pi=>managed.factory(new Proxy(pi,{get(target,key){
    if(key==='registerTool')return (definition:RegisteredTool['definition'])=>{
      if(definition.name!=='Agent')throw safeError('extension_conflict');target.registerTool(definition);
    };
    if(key==='registerCommand')return (name:string,options:Parameters<ExtensionAPI['registerCommand']>[1])=>{
      if(name!=='subagent')throw safeError('extension_conflict');target.registerCommand(name,options);
    };
    return ()=>{throw safeError('extension_conflict');};
  }}));
  const override:NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionsOverride']>=base=>{
    const extensions=base.extensions.filter(extension=>extension.tools.has('Agent'));
    if(base.errors.length||extensions.length!==1)throw safeError('extension_conflict');
    const extension=extensions[0]!;
    if(extension.tools.size!==1||extension.handlers.size||extension.commands.size!==1||!extension.commands.has('subagent')||extension.flags.size||extension.shortcuts.size
      ||extension.messageRenderers.size||extension.entryRenderers?.size||extension.markdownTransformer)throw safeError('extension_conflict');
    registered=extension.tools.get('Agent')!;
    registeredCommand=extension.commands.get('subagent')!;
    return {...base,extensions:extensions.map(item=>({...item,tools:new Map()}))};
  };
  const definitions:readonly AnyToolDefinition[]=[{name:'Agent',label:'Agent',description:'Delegate a foreground read-only verification with independent context.',
    version:SUBAGENT_BUILD.pluginVersion,effect:'READ',executionMode:'parallel',inputSchema:AgentInputSchema,outputSchema:NativeAgentReplySchema,
    execute:async (args,context)=>{
      if(closed||context.runId!==input.runId||context.sessionId!==input.sessionId||context.delegationSource||invocations.has(context.nativeToolCallId))throw safeError('state_conflict');
      if(invocations.size>=4)throw safeError('runtime_busy');
      context.checkActive?.();context.signal.throwIfAborted();
      const session=input.getSession();if(!registered||!session?.extensionRunner)throw safeError('extension_unavailable');
      const parameters=AgentInputSchema.parse(args);input.verifyRole?.(parameters.subagent_type);
      const invocation:Invocation={origin:context,roleId:parameters.subagent_type,released:false,running:true};
      invocations.set(context.nativeToolCallId,invocation);
      try {
        const original=await wrapRegisteredTool(registered,session.extensionRunner).execute(context.nativeToolCallId,parameters,context.signal);
        if(!invocation.id)throw safeError('state_conflict');
        invocation.reply=NativeAgentReplySchema.parse(JSON.parse(nativeHistoryJSON(original)));
        const committed=await persist(invocation);
        if(committed.result.outcome!=='completed')throw invocation.observation!.error??safeError('internal_error',undefined,{reason:'subagent_execution_failed'});
        return invocation.reply;
      }catch(error){
        // A registered child with an unconfirmed save or release still owns this execution.
        if(!invocation.id)invocations.delete(context.nativeToolCallId);
        else if(invocations.get(context.nativeToolCallId)===invocation){const known=AppErrorSchema.safeParse(error);input.fatal(known.success?known.data:safeError('stop_unconfirmed',error));}
        throw error;
      }finally{invocation.running=false;}
    }}];
  return {factory,override,definitions,
    readCommand:()=>{
      const session=input.getSession(),actual=session?.extensionRunner?.getCommand('subagent');
      if(closed||!input.owner||!ExtensionOwnerSchema.safeParse(input.owner).success||input.owner.runId!==input.runId||input.owner.sessionId!==input.sessionId||!registeredCommand||!session?.extensionRunner
        ||actual?.handler!==registeredCommand.handler||actual.sourceInfo!==registeredCommand.sourceInfo
        ||session.extensionRunner.getRegisteredCommands().filter(item=>item.name==='subagent').length!==1
        ||session.extensionRunner.getCommandDiagnostics().length)return null;
      return {name:'subagent' as const,description:registeredCommand.description??'Delegate to a named read-only role',owner:structuredClone(input.owner)};
    },
    prepareCommand:async(command:{inputId:number;operationRef:string;sessionId:number;runId:number;instanceId:string;text:string;roleId:string;task:string;invoke:(text:string)=>Promise<void>}):Promise<CommandReceipt>=>{
      if(closed||pendingCommand)throw safeError('state_conflict');
      const session=input.getSession(),owner=input.owner,actual=session?.extensionRunner?.getCommand('subagent');
      if(!owner||!ExtensionOwnerSchema.safeParse(owner).success||owner.runId!==input.runId||owner.sessionId!==input.sessionId
        ||command.runId!==owner.runId||command.sessionId!==owner.sessionId||command.instanceId!==owner.instanceId)throw safeError('access_denied');
      if(!session||!registeredCommand||actual?.handler!==registeredCommand.handler||actual.sourceInfo!==registeredCommand.sourceInfo
        ||session.extensionRunner.getRegisteredCommands().filter(item=>item.name==='subagent').length!==1
        ||session.extensionRunner.getCommandDiagnostics().length)throw safeError('extension_conflict');
      const match=/^\/subagent ([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]+([\s\S]+)$/.exec(command.text);
      if(!Number.isSafeInteger(command.inputId)||command.inputId<1||!command.operationRef||command.operationRef.length>128
        ||!match||match[1]!==command.roleId||match[2]!==command.task||command.roleId.length>64||!command.task.trim()||command.task.length>65536)throw safeError('invalid_argument');
      input.verifyRole?.(command.roleId);
      const pending:PendingCommand={inputId:command.inputId,operationRef:command.operationRef,roleId:command.roleId,task:command.task};
      pendingCommand=pending;
      try {await command.invoke(command.text);if(closed||input.getSession()!==session)throw safeError('state_conflict');
        if(pending.error||!pending.receipt)throw pending.error??safeError('extension_command_failed');return pending.receipt;
      }finally{pendingCommand=undefined;}
    },
    cancel:(pluginAgentId?:string)=>{for(const invocation of invocations.values())if(invocation.id&&!invocation.released&&(!pluginAgentId||invocation.id===pluginAgentId))managed.control.cancel(invocation.id);},
    retryPersistence:()=>retrying??(retrying=(async()=>{let failure:unknown;for(const invocation of [...invocations.values()])if(!invocation.running)try{await persist(invocation);}catch(error){if(invocations.get(invocation.origin.nativeToolCallId)===invocation)failure??=error;}if(failure)throw failure;})().finally(()=>{retrying=undefined;})),
    close:async()=>{closed=true;if(invocations.size||pendingCommand)throw safeError('stop_unconfirmed');await managed.control.dispose();},
  };
}
