import { expect, test } from 'bun:test';
import type { Model, Api } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { CONTEXT_HTTP_APIS } from '../../packages/contracts/src/context';
import { matchProviderContext } from '../../packages/runtime-pi/src/messages';
import { zstdDecompressSync } from 'node:zlib';

// This proves SDK wire paths and HTTP observation ordering, not model quality or stream completion.
for (const api of CONTEXT_HTTP_APIS) for (const mode of ['success','removed_projection','http_rejection','cancel','retry'] as const) test(`p8 Pi 0.87.1 ${api} ${mode} preserves the real HTTP evidence boundary`, async () => {
  const snapshot = {renderedProjection:'MedClaw fixture materials: 原始数据',runtimeFeedback:'MedClaw fixture trusted feedback: {}'};
  const received: unknown[] = [], statuses: number[] = [], order: string[] = [];
  const controller = new AbortController();
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    const bytes = Buffer.from(await request.arrayBuffer());
    received.push(JSON.parse((request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8'))); order.push('received');
    if(mode === 'http_rejection' || mode === 'retry' && received.length === 1) return new Response(JSON.stringify({error:{type:'api_error',message:'Fixture rejection'},message:'Fixture rejection'}),{status:mode === 'retry' ? 500 : 400,headers:{'content-type':'application/json','x-amzn-errortype':'InternalServerException'}});
    return new Response(api === 'bedrock-converse-stream' ? '' : 'data: [DONE]\n\n',{headers:{'content-type':api === 'bedrock-converse-stream' ? 'application/vnd.amazon.eventstream' : 'text/event-stream'}});
  }});
  const model: Model<Api> = {id:'fixture',name:'Fixture',api,provider:'p8-local-fixture',baseUrl:`http://127.0.0.1:${server.port}/v1`,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024};
  const jwt = `fixture.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64')}.fixture`;
  try {
    expect(VERSION).toBe('0.87.1');
    const stream = streamSimple(model,{messages:[{role:'system',content:'Base product instructions',timestamp:0},{role:'user',content:[{type:'text',text:snapshot.renderedProjection}],timestamp:1},{role:'system',content:snapshot.runtimeFeedback,timestamp:2}]},{apiKey:api === 'openai-codex-responses' ? jwt : 'fixture',transport:'sse',maxRetries:mode === 'retry' ? 1 : 0,maxRetryDelayMs:2000,timeoutMs:2000,env:{AWS_BEDROCK_SKIP_AUTH:'1',AWS_BEDROCK_FORCE_HTTP1:'1',AWS_REGION:'us-east-1'},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]),onPayload:payload => {
      order.push('payload');expect(received).toHaveLength(0);
      const verified = matchProviderContext(api,mode === 'removed_projection' ? null : payload,snapshot);
      if(mode === 'removed_projection') {expect(verified).toBe(false);throw new Error('context_payload_mismatch');}
      expect(verified).toBe(true);if(mode === 'cancel') controller.abort();
    },onResponse:response => {order.push('response');statuses.push(response.status);expect(received.length).toBeGreaterThan(0);}});
    await stream.result();
    if(mode === 'removed_projection' || mode === 'cancel') {expect(received).toHaveLength(0);expect(statuses).toEqual([]);}
    else {
      expect(received.length).toBeGreaterThan(0);for(const payload of received) expect(matchProviderContext(api,payload,snapshot)).toBe(true);
      if(mode === 'success') {expect(received).toHaveLength(1);expect(statuses).toEqual([200]);expect(order).toEqual(['payload','received','response']);}
      if(mode === 'http_rejection') {expect(received).toHaveLength(1);expect(statuses.some(status => status >= 200 && status < 300)).toBe(false);}
      if(mode === 'retry') {
        // Pi/Mistral use one fetch in this fixed release; do not invent SDK retries.
        expect(received).toHaveLength(api === 'pi-messages' || api === 'mistral-conversations' ? 1 : 2);
        expect(statuses.filter(status => status === 200)).toHaveLength(api === 'pi-messages' || api === 'mistral-conversations' ? 0 : 1);
      }
    }
  } finally {server.stop(true);}
},10000);
