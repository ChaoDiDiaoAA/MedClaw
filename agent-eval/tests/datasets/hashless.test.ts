import {test,expect} from 'bun:test';
import {loadDataset,loadSnapshot} from '../../src/datasets.ts';
import {assertNoDatasetHashes,projectPublicEvidence} from '../../src/data-format.ts';
test('archive boundary rejects digest fields and embedded digest values',async()=>{
  const dataset=await loadDataset();expect(()=>assertNoDatasetHashes(dataset.snapshot)).not.toThrow();
  for(const value of [{reportHash:'x'},{metadata:{digest:'x'}},{id:'a'.repeat(64)},{input:'@runtime:context-hash'}])expect(()=>assertNoDatasetHashes(value)).toThrow();
  const changed=structuredClone(dataset.snapshot) as any;changed.info.version=2;expect(()=>loadSnapshot(changed)).toThrow();
});
test('product projection preserves actual content and ownership while removing protocol digests',()=>{
  const projected=projectPublicEvidence({selector:{kind:'request',callId:'c',runId:2,sessionId:3},protocolValidated:true,sha256:'a'.repeat(64),original:[{callId:'c',body:JSON.stringify({text:'hello',contentHash:'b'.repeat(64)}),bytes:999,sha256:'c'.repeat(64)}],bytes:999});
  expect(()=>assertNoDatasetHashes(projected)).not.toThrow();expect(projected.original[0]!.body).toBe('{\"text\":\"hello\"}');
  expect(projected.bytes).toBe(Buffer.byteLength(JSON.stringify(projected.original)));expect(projected.selector.runId).toBe(2);
  const content='{"actual": "content"}\n';
  expect(projectPublicEvidence({content})).toEqual({content});
  expect(projectPublicEvidence(projected)).toEqual(projected);
});
