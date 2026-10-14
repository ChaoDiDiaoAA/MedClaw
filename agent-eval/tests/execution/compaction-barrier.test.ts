import {expect,test} from 'bun:test';
import {ActionExecutor} from '../../src/adapters/actions.ts';
import type {ProductAdapter} from '../../src/adapters/product.ts';
import type {ResolvedRunConfig} from '../../src/types.ts';

function fixture(states:{status:string;canContinue:boolean;error?:{code:string};calls?:{error:{code:string}}[]}[],timeout=1000,beforeModel?:()=>void) {
  let reads=0,ref='';const methods:string[]=[];
  const view=(state:typeof states[number])=>({sessionId:1,operationRef:ref,receipt:state.status==='running'?null:{operationRef:ref,sessionId:1},calls:[],...state});
  const product={deadlineAt:Date.now()+timeout,async request(method:string,_payload:unknown,operationRef?:string){
    methods.push(method);
    if(method==='session.read')return {ok:true,data:{session:{storageVersion:1}}};
    if(method==='session.compact'){ref=operationRef!;return {ok:true,data:view({status:'running',canContinue:false})};}
    if(method==='session.compaction.read')return {ok:true,data:view(states[Math.min(reads++,states.length-1)]!)};
    throw new Error('unexpected_request');
  }} as unknown as ProductAdapter;
  const executor=new ActionExecutor(product,{} as ResolvedRunConfig,'','');
  executor.aliases.sessions.set('main',{id:1,nativeSessionId:'native'});
  Object.defineProperty(executor,'model',{value:async()=>{beforeModel?.();return {provider:'fixture',modelId:'fixture',expectedConfigVersion:'1'};}});
  return {executor,methods,get reads(){return reads;}};
}

test('compaction acceptance waits for its original receipt and continuation gate',async()=>{
  const f=fixture([{status:'running',canContinue:false},{status:'completed',canContinue:false},{status:'completed',canContinue:true}]);
  expect(await f.executor.execute({action:'compact',sessionAlias:'main'})).toMatchObject({status:'completed',canContinue:true});
  expect(f.reads).toBe(3);expect(f.methods.filter(x=>x==='session.compact')).toHaveLength(1);
});

test('compaction failure surfaces original provider cause instead of permitting a subsequent send',async()=>{
  const f=fixture([{status:'failed',canContinue:false,error:{code:'compaction_failed'}}]);
  await expect(f.executor.execute({action:'compact',sessionAlias:'main'})).rejects.toThrow('compaction_failed');
  expect(f.methods).not.toContain('session.submit');
});

test('compaction that never becomes eligible stops at the existing deadline',async()=>{
  const f=fixture([{status:'completed',canContinue:false}],35);
  await expect(f.executor.execute({action:'compact',sessionAlias:'main'})).rejects.toThrow('compaction_wait_timeout');
  expect(f.methods.filter(x=>x==='session.compact')).toHaveLength(1);
});

test('aborted compaction does not submit or retry an operation',async()=>{
  const f=fixture([{status:'running',canContinue:false}]);
  await expect(f.executor.execute({action:'compact',sessionAlias:'main'},AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  expect(f.methods).toEqual([]);
});

test('cancellation during configuration verification prevents the compaction submission',async()=>{
  const controller=new AbortController(),f=fixture([{status:'running',canContinue:false}],1000,()=>controller.abort(new Error('cancelled')));
  await expect(f.executor.execute({action:'compact',sessionAlias:'main'},controller.signal)).rejects.toThrow('cancelled');
  expect(f.methods).not.toContain('session.compact');
});

test('a failed summary remains the primary cause when saving also fails',async()=>{
  const f=fixture([{status:'failed',canContinue:false,error:{code:'storage_write_failed'},calls:[{error:{code:'provider_request_failed'}}]}]);
  await expect(f.executor.execute({action:'compact',sessionAlias:'main'})).rejects.toThrow('provider_request_failed');
  expect(f.methods.filter(x=>x==='session.compact')).toHaveLength(1);
});

test('a save-only failure retains its identity and forbids continuation',async()=>{
  const f=fixture([{status:'failed',canContinue:false,error:{code:'storage_write_failed'}}]);
  await expect(f.executor.execute({action:'compact',sessionAlias:'main'})).rejects.toThrow('storage_write_failed');
  expect(f.methods).not.toContain('session.submit');
});

test('cancellation during receipt polling stops without resubmitting the summary',async()=>{
  const f=fixture([{status:'running',canContinue:false}]),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('cancelled')),40);
  try {
    await expect(f.executor.execute({action:'compact',sessionAlias:'main'},controller.signal)).rejects.toThrow('cancelled');
    expect(f.reads).toBeGreaterThan(0);expect(f.methods.filter(x=>x==='session.compact')).toHaveLength(1);
  } finally {clearTimeout(timer);}
});
