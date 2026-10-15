import {test,expect} from 'bun:test';
import {readQueryInventory} from '../../src/execution/observe.ts';
import type {ProductAdapter} from '../../src/adapters/product.ts';

test('private query inventory includes uncited queries in multiple root and child Sessions without selecting them',async()=>{
  const requests:unknown[]=[];
  const product={instanceId:'host',request:async(method:string,input:any)=>{
    requests.push([method,input.selector]);
    const original={instanceId:input.ownerInstanceId,runId:input.selector.runId,sessionId:input.selector.sessionId,queryIds:input.selector.runId===7?[1,2]:[3]};
    const bytes=Buffer.from(JSON.stringify(original));
    return {ok:true,data:{instanceId:'host',ownerInstanceId:input.ownerInstanceId,selector:input.selector,bytes:bytes.length,offset:0,nextOffset:null,encoding:'base64',data:bytes.toString('base64')}};
  }} as unknown as ProductAdapter;
  const result=await readQueryInventory(product,[{id:7,sessionId:1,instanceId:'host'},{id:9,sessionId:2,instanceId:'host'}]);
  expect(result.queryIds).toEqual([1,2,3]);expect(result.originals).toHaveLength(2);
  expect(requests).toContainEqual(['controller.evidence.read',{kind:'queries',runId:9,sessionId:2}]);
  const failed={instanceId:'host',request:async()=>({ok:false,error:{code:'host_interrupted'}})} as unknown as ProductAdapter;
  await expect(readQueryInventory(failed,[{id:7,sessionId:1,instanceId:'host'}])).rejects.toThrow('host_interrupted');
});
