import {mkdtempSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {HostController} from '../../apps/desktop/src/main/host-controller';
import type {AppError} from '../../packages/contracts/src/error';
import type {HostView} from '../../packages/contracts/src/model';
import type {DesktopNotice} from '../../packages/contracts/src/protocol';

export async function fixture(mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "medclaw P1 中文 -"));
  const entry = join(root, "host.ts");
  await Bun.write(entry, `import {createInterface} from "node:readline";import {appendFileSync,existsSync,writeFileSync} from "node:fs";
const mode=${JSON.stringify(mode)};const lines=createInterface({input:process.stdin});let hello,ready;const pending=new Map();
function send(value){process.stdout.write(JSON.stringify(value)+"\\n");}
function emitReady(){const text=JSON.stringify(ready)+"\\n";process.stdout.write(text.slice(0,17));setTimeout(()=>process.stdout.write(text.slice(17)),5);}
lines.on("line",line=>{const frame=JSON.parse(line);if(!hello){hello=frame;
if(process.env.AWS_MAX_ATTEMPTS!=="1"||process.env.MEDCLAW_INSTANCE_ID!==hello.instanceId||process.env.MEDCLAW_STARTUP_TOKEN!==hello.startupToken)process.exit(41);
if(mode==="reject-restart"){const marker=${JSON.stringify(join(root,'started-once'))};if(existsSync(marker))process.exit(43);writeFileSync(marker,'started');}
ready={protocolVersion:hello.protocolVersion,instanceId:hello.instanceId,sdkVersion:hello.sdkVersion,schemaVersion:hello.expectedSchemaVersion,configVersion:"1",dataRoot:hello.paths.dataRoot};
if(mode==="wrong-instance")ready.instanceId="unrelated-instance";
if(mode==="wrong-protocol")ready.protocolVersion="unrelated-protocol";
if(mode==="wrong-sdk")ready.sdkVersion="0.0.0";
if(mode==="wrong-schema")ready.schemaVersion=999;
if(mode==="wrong-root")ready.dataRoot=hello.paths.databasePath;
if(mode==="oversized"){process.stdout.write("x".repeat(4*1024*1024+1));return;}
if(mode==="truncated"){process.stdout.write("{");setTimeout(()=>process.exit(0),5);return;}
if(mode==="invalid-utf8"){process.stdout.write(Buffer.from([255,10]));return;}
if(mode==="silence")return;
if(mode==="pre-ready"||mode==="invalid-private"){
for(const method of ["credential.read","credential.list"]){const requestId="initial-"+method;pending.set(requestId,{initial:true});send({protocolVersion:hello.protocolVersion,kind:"private",instanceId:hello.instanceId,requestId,secret:mode!=="invalid-private",method,payload:method==="credential.read"?{providerId:"p1-offline",context:{purpose:"runtime",operationRef:"catalog"}}:{}});}return;}
emitReady();return;}
if(frame.kind==="private"){const request=pending.get(frame.requestId);if(!request||!frame.result.ok)process.exit(42);pending.delete(frame.requestId);if(request.initial){if(!pending.size)emitReady();return;}if(frame.result.data!==null)process.exit(42);
const reply={protocolVersion:hello.protocolVersion,kind:"reply",instanceId:hello.instanceId,requestId:request.requestId,result:{ok:true,data:{providers:[],models:[],configVersion:"1",selection:null,customApis:[]}}};
if(mode==="duplicate"){process.stdout.write([reply,reply,{...reply,requestId:"unknown-reply"}].map(value=>JSON.stringify(value)+"\\n").join(""));return;}
if(mode==="preview"){for(let i=0;i<64;i++)send({protocolVersion:hello.protocolVersion,kind:"notice",instanceId:hello.instanceId,notice:{type:"provider.preview",runId:1,text:"preview-"+i,truncated:false}});setTimeout(()=>send({protocolVersion:hello.protocolVersion,kind:"notice",instanceId:hello.instanceId,notice:{type:"provider.settled",runId:1}}),80);}
send(reply);return;}
if(frame.method==="host.shutdown"){send({protocolVersion:hello.protocolVersion,kind:"reply",instanceId:hello.instanceId,requestId:frame.requestId,result:{ok:true,data:{executionStopped:true,databaseClosed:true}}});if(mode!=="ack-without-exit")setTimeout(()=>process.exit(0),5);return;}
if(mode==="lost-reply"&&["model.list","session.messages.read","session.readSubmission","session.create"].includes(frame.method)){appendFileSync(${JSON.stringify(join(root, "received.jsonl"))},JSON.stringify(frame)+"\\n");return;}
if(frame.method==="model.list"){const requestId="private-"+frame.requestId;pending.set(requestId,frame);send({protocolVersion:hello.protocolVersion,kind:"private",instanceId:hello.instanceId,requestId,secret:true,method:"credential.read",payload:{providerId:"p1-offline",context:{purpose:"runtime",operationRef:frame.operationRef}}});}
});lines.on("close",()=>process.exit(0));`);
  return { root, entry };
}

const errorFields=(error:AppError|null)=>error?{code:error.code,...(error.reason===undefined?{}:{reason:error.reason})}:null;

export function createHostDiagnostics(){
  const began=performance.now();
  const elapsedMs=()=>Math.round(performance.now()-began);
  const transitions:{phase:string;elapsedMs:number;instanceId:string|null;state:HostView['state'];canStart:boolean;error:ReturnType<typeof errorFields>}[]=[];
  const errors:{phase:string;elapsedMs:number;error:ReturnType<typeof errorFields>}[]=[];
  const events:{phase:string;elapsedMs:number;instanceId:string;event:'start'|'exit'}[]=[];
  const exits:{instanceId:string;pid:number|undefined;code:number|null;signal:NodeJS.Signals|null;elapsedMs:number}[]=[];
  const trace={phase:'fixture-setup',transitions,errors,events,exits,
    starting(instanceId:string,child:ChildProcessWithoutNullStreams){
      events.push({phase:trace.phase,elapsedMs:elapsedMs(),instanceId,event:'start'});
      child.once('exit',(code,signal)=>exits.push({instanceId,pid:child.pid,code,signal,elapsedMs:elapsedMs()}));
    },
    onExit(instanceId:string){events.push({phase:trace.phase,elapsedMs:elapsedMs(),instanceId,event:'exit'});},
    onError(error:AppError){errors.push({phase:trace.phase,elapsedMs:elapsedMs(),error:errorFields(error)});},
    onNotice(notice:DesktopNotice){if(notice.type==='host.status'){
      const host=notice.host;transitions.push({phase:trace.phase,elapsedMs:elapsedMs(),instanceId:host.instanceId,state:host.state,canStart:host.canStart,error:errorFields(host.error)});
    }},
  };
  return trace;
}

export async function finishHostFixture(host:Pick<HostController,'read'|'stop'>,root:string,entry:string,trace:ReturnType<typeof createHostDiagnostics>,failed:boolean){
  const observed=host.read(),phase=trace.phase;
  trace.phase='cleanup';
  let cleanupError:string|undefined;
  if(observed.instanceId&&!observed.canStart){try{await host.stop(observed.instanceId);}catch{cleanupError='fixture_stop_failed';}}
  const final=host.read(),cleanupConfirmed=final.canStart;
  const context={phase,state:observed.state,error:errorFields(observed.error),instanceId:observed.instanceId,
    entryExists:existsSync(entry),dataDirectoryExists:existsSync(root),lockExists:existsSync(join(root,'runtime/host.lock')),
    transitions:trace.transitions,errors:trace.errors,events:trace.events,exits:trace.exits,cleanupConfirmed,cleanupState:final.state};
  if(cleanupConfirmed){try{rmSync(root,{recursive:true,force:true});}catch{cleanupError='fixture_remove_failed';}}
  if(failed||!cleanupConfirmed||cleanupError)console.error('HOST_TEST_DIAGNOSTIC '+JSON.stringify({...context,cleanupError,...(!cleanupConfirmed||cleanupError?{fixtureDirectory:root}:{})}));
  trace.phase=phase;
  if(!failed&&(!cleanupConfirmed||cleanupError))throw new Error(cleanupError??'fixture_stop_unconfirmed');
  return cleanupConfirmed;
}
