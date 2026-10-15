import {expect,test} from 'bun:test';
import {streamSimple} from '@earendil-works/pi-ai/compat';
import type {Api,Model,Message} from '@earendil-works/pi-ai';
import {CONTEXT_HTTP_APIS} from '../../packages/contracts/src/context';
import {matchProviderResources,type ExpectedResource} from '../../packages/runtime-pi/src/messages';
import {zstdDecompressSync} from 'node:zlib';

// Real SDK wire/HTTP evidence; empty SSE/AWS streams deliberately make no quality or inference-completion claim.
for (const api of CONTEXT_HTTP_APIS) for (const mode of ['success','missing_input','missing_index','missing_read','http_rejection','cancel'] as const)
test(`p11 real ${api} resource proof ${mode}`,async()=>{
  const index = '  <skill>\n    <name>query</name>\n    <description>ENGINEERING</description>\n    <location>/fixture/SKILL.md</location>\n  </skill>', input = 'ENGINEERING identical expanded input', read = 'ENGINEERING reference body\n';
  const ref = {kind:'skill' as const,id:'query',version:'v1'};
  const expected:ExpectedResource[] = [
    ...[0,1].map(i=>({text:input,userIndex:i,fact:{resourceRef:ref,originRunId:i+1,file:'SKILL.md',inputId:i+1,nativeEntryId:`entry-${i}`,toolCallId:null,coverage:'complete' as const,kind:'skill_expansion' as const}})),
    {text:read,toolIndex:0,fact:{resourceRef:ref,originRunId:1,file:'references/example.md',inputId:null,nativeEntryId:'tool-entry',toolCallId:1,coverage:'complete',kind:'native_read'}},
    {text:index,fact:{resourceRef:ref,originRunId:2,file:null,inputId:null,nativeEntryId:null,toolCallId:null,coverage:'index',kind:'skill_index'}}];
  const model:Model<Api> = {id:'fixture',name:'Fixture',api,provider:'p11-local-fixture',baseUrl:'',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024};
  const received:unknown[] = [], order:string[] = [], delivered:unknown[] = [], controller = new AbortController();
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const bytes = Buffer.from(await request.arrayBuffer());
    received.push(JSON.parse((request.headers.get('content-encoding')==='zstd'?zstdDecompressSync(bytes):bytes).toString('utf8')));order.push('received');
    return new Response(mode==='http_rejection'?'{}':api==='bedrock-converse-stream'?'':'data: [DONE]\n\n',{status:mode==='http_rejection'?400:200,headers:{'content-type':api==='bedrock-converse-stream'?'application/vnd.amazon.eventstream':'text/event-stream'}});
  }});model.baseUrl=`http://127.0.0.1:${server.port}/v1`;
  const messages:Message[] = [
    {role:'system',content:mode==='missing_index'?'Base':`Base\n\n${index}`,timestamp:0},
    {role:'user',content:mode==='missing_input'?'removed':input,timestamp:1},{role:'user',content:input,timestamp:2},
    {role:'assistant',api,provider:model.provider,model:model.id,timestamp:3,stopReason:'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},content:[{type:'toolCall',id:'read00001',name:'read',arguments:{path:'/fixture/reference.md'}}]},
    {role:'toolResult',toolCallId:'read00001',toolName:'read',content:[{type:'text',text:mode==='missing_read'?'removed':read}],isError:false,timestamp:4},
    {role:'user',content:'P8 projection without resource text',timestamp:5},{role:'system',content:'P8 trusted feedback',timestamp:6}];
  const jwt=`fixture.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64')}.fixture`;
  let observation:unknown;
  try {
    const stream = streamSimple(model,{messages},{apiKey:api==='openai-codex-responses'?jwt:'fixture',transport:'sse',maxRetries:0,timeoutMs:2000,env:{AWS_BEDROCK_SKIP_AUTH:'1',AWS_BEDROCK_FORCE_HTTP1:'1',AWS_REGION:'us-east-1'},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]),
      onPayload(payload){order.push('payload');observation=matchProviderResources(payload,api,expected);if(mode==='cancel')controller.abort();},
      onResponse(response){order.push('response');if(response.status>=200&&response.status<300)delivered.push(observation);}});
    await stream.result();
    expect(order[0]).toBe('payload');
    if(mode.startsWith('missing_')||mode==='cancel'){expect(received).toHaveLength(0);expect(delivered).toEqual([]);}
    else {expect(received).toHaveLength(1);expect(matchProviderResources(received[0],api,expected).verified).toEqual(expected.map(e=>e.fact));
      expect(delivered).toHaveLength(mode==='success'?1:0);expect(order.slice(0,2)).toEqual(['payload','received']);if(mode==='success')expect(order).toEqual(['payload','received','response']);}
  } finally {server.stop(true);}
},10000);

test('p11 resource wire matching rejects nested decoys, swapped Tool IDs, repeated results and unsupported APIs',()=>{
  const ref={kind:'skill' as const,id:'query',version:'v1'}, expected:ExpectedResource[]=[{text:'read body',toolIndex:0,fact:{resourceRef:ref,originRunId:1,file:'SKILL.md',inputId:null,nativeEntryId:'entry',toolCallId:1,coverage:'complete',kind:'native_read'}}];
  const call={role:'assistant',tool_calls:[{id:'original',function:{name:'read'}}]}, result={role:'tool',tool_call_id:'original',content:'read body'};
  for(const payload of [{messages:[call,{...result,content:'wrong'}],decoy:'read body'},{messages:[call,{...result,tool_call_id:'other'}]},{messages:[call,result,result]}])
    expect(()=>matchProviderResources(payload,'openai-completions',expected)).toThrow();
  expect(()=>matchProviderResources({messages:[call,result]},'unsupported',expected)).toThrow();
  expect(matchProviderResources({messages:[call,result]},'openai-completions',expected).verified).toHaveLength(1);
});
