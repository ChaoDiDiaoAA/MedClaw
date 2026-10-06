import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PositiveIdSchema, safeError } from '@medclaw/contracts/error';
import { canonicalRequest } from '@medclaw/contracts/run';
import type { PublishedSettings } from '@medclaw/contracts/model';
import { ExtensionManifestSchema, FrozenRunExtensionsSchema, EXTENSION_LIMITS, type FrozenRunExtensions, type ExtensionDescriptor } from '@medclaw/contracts/extensions';
import { managedPath, readText } from './resource-loader';
import { z } from 'zod';
import { wrapRegisteredTool, type AgentSession, type ExtensionAPI, type ExtensionFactory, type RegisteredTool, type DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { ExtensionOwnerSchema, ExtensionAssemblyProofSchema, ExtensionStatusSchema, type ExtensionOwner, type ExtensionAssemblyProof, type ExtensionStatus } from '@medclaw/contracts/extensions';
import type { AnyToolDefinition } from '@medclaw/contracts/tool';
import type { AppError } from '@medclaw/contracts/error';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => safeError('extension_unavailable');
function sourceRef(source: NonNullable<FrozenRunExtensions['source']>) {
  const { manifest, files } = source;
  const metadata = { id: manifest.id, version: manifest.version, sdkVersion: manifest.sdkVersion,
    files: files.map(({file,bytes,sha256}) => ({file,bytes,sha256})).sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0) };
  return { id: manifest.id, version: manifest.version, treeHash: hash(canonicalRequest(metadata)) };
}
function checkedFrozen(value: FrozenRunExtensions) {
  const frozen = FrozenRunExtensionsSchema.parse(value);
  if (frozen.source && (frozen.source.files.some(file => hash(file.content) !== file.sha256)
    || !isDeepStrictEqual(JSON.parse(frozen.source.files.find(file => file.file === 'manifest.json')!.content), frozen.source.manifest)
    || !isDeepStrictEqual(sourceRef(frozen.source), frozen.selection.extension))) throw unavailable();
  return frozen;
}
async function readSource(root: string): Promise<NonNullable<FrozenRunExtensions['source']>> {
  const directory = await managedPath(root,'tool-audit/v1');
  const names: string[] = []; for await (const entry of await opendir(directory)) names.push(entry.name);
  if (!isDeepStrictEqual(names.sort(),['index.ts','manifest.json'])) throw unavailable();
  const manifestFile = await readText(root,'tool-audit/v1/manifest.json',EXTENSION_LIMITS.manifestBytes);
  const entryFile = await readText(root,'tool-audit/v1/index.ts',EXTENSION_LIMITS.entryBytes);
  const manifest = ExtensionManifestSchema.parse(JSON.parse(manifestFile.content));
  return { manifest, files: [{...manifestFile,file:'manifest.json'}, {...entryFile,file:'index.ts'}] };
}
export async function readExtensionDescriptor(root: string): Promise<ExtensionDescriptor> {
  try {
    const source = await readSource(root), { manifest } = source;
    return { ref:sourceRef(source), source:'first_party', sdkVersion:manifest.sdkVersion,entry:manifest.entry,hooks:manifest.hooks,tools:manifest.tools,commands:manifest.commands };
  } catch { throw unavailable(); }
}
export async function freezeRunExtensions(root: string | undefined, sessionId: number, settings: PublishedSettings): Promise<FrozenRunExtensions> {
  PositiveIdSchema.parse(sessionId);
  const selection = settings.extensions?.bySession[String(sessionId)] ?? {extension:null};
  const fields = {contract:'medclaw.run-extensions/v1' as const,sdkVersion:'0.87.1' as const,sessionId,configVersion:settings.configVersion,selection};
  if (!selection.extension) return {...fields,source:null};
  try {
    if (!root) throw unavailable();
    const source = await readSource(root);
    return checkedFrozen({...fields,source});
  } catch { throw unavailable(); }
}
export async function materializeRunExtension(workdir: string, value: FrozenRunExtensions): Promise<string | null> {
  try {
    const frozen = checkedFrozen(value); if (!frozen.source) return null;
    const directory = `extensions/tool-audit/v1/${frozen.selection.extension!.treeHash}`;
    await managedPath(workdir); let prefix = '';
    for (const part of directory.split('/')) {
      prefix = [prefix,part].filter(Boolean).join('/');
      try { await mkdir(join(workdir,prefix)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!(await lstat(await managedPath(workdir,prefix))).isDirectory()) throw unavailable();
    }
    for (const file of frozen.source.files) {
      const path = `${directory}/${file.file}`;
      try { const handle = await open(join(workdir,path),'wx'); try {await handle.writeFile(Buffer.from(file.content,'utf8'));} finally {await handle.close();} }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const actual = await readText(workdir,path,file.file === 'manifest.json' ? EXTENSION_LIMITS.manifestBytes : EXTENSION_LIMITS.entryBytes);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw unavailable();
    }
    return join(workdir,directory,'index.ts');
  } catch { throw unavailable(); }
}

export async function loadRunExtension(workdir: string, frozen: FrozenRunExtensions, owner: ExtensionOwner,
  callbacks: { fatal(error: AppError): void; abort(): void; proof(value: ExtensionAssemblyProof): void }, reservedTools: readonly string[], getSession: () => AgentSession | undefined) {
  ExtensionOwnerSchema.parse(owner); const ref=frozen.selection.extension; if(!ref||frozen.sessionId!==owner.sessionId)throw unavailable();
  const proof:ExtensionAssemblyProof={...owner,contract:'medclaw.extension-assembly/v1',ref,state:'loading',loadedAt:null,disposedAt:null,callableTools:[],callableCommands:[],
    hookCounts:{input:0,context:0,tool_call:0,tool_result:0},resourcesReleased:false,diagnostics:[]};
  callbacks.proof(proof);
  const entry=await materializeRunExtension(workdir,frozen); if(!entry)throw unavailable();
  const module=await import(entry);
  if(typeof module.createToolAudit!=='function')throw unavailable();
  const instance:{factory:ExtensionFactory;readStatus():ExtensionStatus;close():Promise<void>}=module.createToolAudit({...owner,ref});
  if(typeof instance?.factory!=='function'||typeof instance.readStatus!=='function'||typeof instance.close!=='function')throw unavailable();
  let lease=true, registering=false, fatal:AppError|null=null, closing:Promise<void>|undefined, closeWait:Promise<void>|undefined, commandPending=false, captured:ExtensionStatus|null=null, commandError:AppError|null=null;
  const tasks=new Set<Promise<unknown>>(), subscriptions:Array<()=>void>=[], hooks=new Set<string>(), tools=new Set<string>(), commands=new Set<string>();
  let registered:RegisteredTool|undefined, nativeSession:AgentSession|undefined;
  const track=async<T>(task:Promise<T>):Promise<T>=>{tasks.add(task);try{return await task;}finally{tasks.delete(task);}};
  const diagnose=(error:AppError)=>{if(proof.diagnostics.length<8)proof.diagnostics.push(error);};
  const fail=(code='extension_unavailable')=>{const error=safeError(code,undefined,{runId:owner.runId,sessionId:owner.sessionId});diagnose(error);return error;};
  const assertLive=()=>{if(!lease||fatal)throw fatal??safeError('state_conflict');};
  const status=()=>{
    const result=ExtensionStatusSchema.parse(instance.readStatus());
    if(!isDeepStrictEqual({...owner,ref},{instanceId:result.instanceId,sessionId:result.sessionId,runId:result.runId,assemblyId:result.assemblyId,ref:result.ref}))throw fail();
    return result;
  };
  const factory:ExtensionFactory=pi=>{
    registering=true;
    const guard=new Proxy(pi,{get(target,key){
      if(key==='on')return (event:string,handler:(event:unknown,context:unknown)=>unknown)=>{
        const critical=frozen.source!.manifest.hooks.critical.includes(event as 'session_start'|'tool_call');
        if(!registering||hooks.has(event)||!critical&&!frozen.source!.manifest.hooks.observation.includes(event as 'input'))throw fail('extension_conflict');
        hooks.add(event);
        const wrapped=async (value:unknown,context:unknown)=>{
          if(!lease)return;
          if(event in proof.hookCounts)proof.hookCounts[event as keyof typeof proof.hookCounts]++;
          const task=Promise.resolve().then(()=>handler(critical?value:structuredClone(value),context)); tasks.add(task);
          try {const result=await task; if(critical){assertLive();return result;}}
          catch {if(!lease)return;const error=fail('extension_hook_failed');if(critical){fatal??=error;callbacks.fatal(error);callbacks.abort();throw error;}}
          finally {tasks.delete(task);}
        };
        const unsubscribe=Reflect.apply(target.on,target,[event,wrapped]) as ()=>void; subscriptions.push(unsubscribe); return unsubscribe;
      };
      if(key==='registerTool')return (definition:RegisteredTool['definition'])=>{
        if(!registering||definition.name!=='extension_runtime_status'||tools.has(definition.name)||reservedTools.includes(definition.name))throw fail('extension_conflict');
        tools.add(definition.name);target.registerTool(definition);
      };
      if(key==='registerCommand')return (name:string,options:Parameters<ExtensionAPI['registerCommand']>[1])=>{
        if(!registering||name!=='extension_status'||commands.has(name))throw fail('extension_conflict');commands.add(name);
        target.registerCommand(name,{...options,handler:async (args,context)=>{
          captured=null;commandError=null;
          try {assertLive();await options.handler(args,context);assertLive();captured=status();}
          catch {commandError=fail('extension_command_failed');throw commandError;}
        }});
      };
      return ()=>{throw fail('extension_unavailable');};
    }});
    try {
      const result=instance.factory(guard);
      if(result){const task=Promise.resolve(result);tasks.add(task);void task.finally(()=>tasks.delete(task)).catch(()=>{});throw fail();}
      if(hooks.size!==7||tools.size!==1||commands.size!==1)throw fail('extension_conflict');
    } finally {registering=false;}
  };
  const override:NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionsOverride']>=base=>{
    if(base.errors.length||base.extensions.length!==1)throw fail();
    registered=base.extensions[0]!.tools.get('extension_runtime_status');if(!registered)throw fail('extension_conflict');
    return {...base,extensions:base.extensions.map(extension=>({...extension,tools:new Map()}))};
  };
  const definitions:readonly AnyToolDefinition[]=[{name:'extension_runtime_status',label:'Extension runtime status',description:'Read the original Run extension identity and observed hook counters.',
    version:'1.0.0',effect:'PURE',executionMode:'parallel',inputSchema:z.strictObject({}),outputSchema:ExtensionStatusSchema,
    execute:async (input,context)=>{
      assertLive();context.signal.throwIfAborted();if(context.runId!==owner.runId||context.sessionId!==owner.sessionId)throw safeError('access_denied');
      const session=getSession();if(!registered||!session?.extensionRunner)throw fail();
      const result=await wrapRegisteredTool(registered,session.extensionRunner).execute(context.nativeToolCallId,input,context.signal);
      const value=ExtensionStatusSchema.parse(result.details);
      if(value.runId!==owner.runId||value.sessionId!==owner.sessionId||value.instanceId!==owner.instanceId||value.assemblyId!==owner.assemblyId||!isDeepStrictEqual(value.ref,ref))throw fail();
      return value;
    }}];
  const close=(dispose:()=>void)=>{
    if(!closing) {
      lease=false;
      closing=(async()=>{
        for(const unsubscribe of subscriptions.splice(0))unsubscribe();
        await Promise.allSettled([...tasks]);await instance.close();nativeSession?.dispose();dispose();
        proof.state='disposed';proof.resourcesReleased=true;proof.disposedAt=new Date().toISOString();
      })().catch(error=>{diagnose(safeError('extension_cleanup_failed',error,{runId:owner.runId,sessionId:owner.sessionId}));});
      closeWait=(async()=>{
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([closing,new Promise<void>(resolve=>{timer=setTimeout(()=>{
          diagnose(safeError('extension_cleanup_failed',undefined,{runId:owner.runId,sessionId:owner.sessionId}));resolve();
        },EXTENSION_LIMITS.closeMs);})]);}finally{clearTimeout(timer);}
      })();
    }
    return closeWait!;
  };
  return {factory,override,definitions,proof,close,track,
    bindSession:(session:AgentSession)=>{if(nativeSession&&nativeSession!==session)throw fail();nativeSession=session;assertLive();},
    assertLive,
    failed:()=>{if(proof.state==='loading')proof.state='load_failed';},
    active:(session:AgentSession)=>{
      assertLive();if(!session.getActiveToolNames().includes('extension_runtime_status')||!session.extensionRunner?.getCommand('extension_status')
        ||session.extensionRunner.getRegisteredCommands().length!==1||session.extensionRunner.getCommandDiagnostics().length)throw fail('extension_conflict');
      proof.state='active';proof.loadedAt=new Date().toISOString();proof.callableTools=['extension_runtime_status'];proof.callableCommands=['extension_status'];ExtensionAssemblyProofSchema.parse(proof);callbacks.proof(proof);
    },
    onError:()=>{diagnose(safeError('extension_hook_failed',undefined,{runId:owner.runId,sessionId:owner.sessionId}));},
    command:async (prompt:AgentSession['prompt'])=>{
      assertLive();if(proof.state!=='active'||commandPending)throw safeError('state_conflict');commandPending=true;captured=null;commandError=null;
      const task=prompt('/extension_status',{expandPromptTemplates:true});tasks.add(task);
      try{await task;assertLive();if(commandError||!captured)throw commandError??fail('extension_command_failed');return captured;}
      finally{tasks.delete(task);commandPending=false;}
    },
  };
}
