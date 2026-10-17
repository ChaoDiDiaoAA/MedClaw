import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProductAdapter } from '../../src/adapters/product.ts';
import { listAllInputs, readAllMessages } from '../../src/adapters/actions.ts';
import { archiveArtifactFiles,copyEvidenceTree, verifyCopiedArtifact, within } from '../../src/adapters/files.ts';
import { cleanupInstance } from '../../src/execution/instance.ts';
import type { VerifiedObservation } from '../../src/types.ts';
import { canonicalRequest } from '../../../packages/contracts/src/run.ts';
import { ExportArtifactSchema, ExportManifestSchema } from '../../../packages/contracts/src/export.ts';

test('message pagination pins original native leaf and reads every returned cursor', async () => {
  const product = new ProductAdapter({ dataRoot: tmpdir(), tracePath: join(tmpdir(), 'not-written') }), requests: unknown[] = [];
  let call = 0;
  const spy = spyOn(product, 'request').mockImplementation(async (_method: string, payload: unknown) => {
    requests.push(payload); call++;
    return { ok: true, data: { sessionId: 7, nativeSessionId: 'native', leafId: 'recorded-leaf', source: 'sqlite_history', items: [], nextEntryId: call < 3 ? `cursor-${call}` : null, hasMore: call < 3 } } as never;
  });
  try {
    expect(await readAllMessages(product, 7)).toHaveLength(3);
    expect(requests).toEqual([{ sessionId: 7, leafId: null, afterEntryId: null, limit: 100 }, { sessionId: 7, leafId: 'recorded-leaf', afterEntryId: 'cursor-1', limit: 100 }, { sessionId: 7, leafId: 'recorded-leaf', afterEntryId: 'cursor-2', limit: 100 }]);
  } finally { spy.mockRestore(); }
});
test('cursor loops and changed native Session identities fail closed', async () => {
  const product = new ProductAdapter({ dataRoot: tmpdir(), tracePath: join(tmpdir(), 'not-written') });
  const spy = spyOn(product, 'request').mockImplementation(async () => ({ ok: true, data: { sessionId: 7, nativeSessionId: 'native', leafId: 'leaf', source: 'sqlite_history', items: [], nextEntryId: 'same', hasMore: true } }) as never);
  try { await expect(readAllMessages(product, 7)).rejects.toThrow('message_identity_or_cursor_mismatch'); }
  finally { spy.mockRestore(); }
  let call = 0;
  const identitySpy = spyOn(product, 'request').mockImplementation(async () => ({ ok: true, data: { sessionId: 7, nativeSessionId: ++call === 1 ? 'native' : 'wrong-native', leafId: 'leaf', source: 'sqlite_history', items: [], nextEntryId: call === 1 ? 'first' : null, hasMore: call === 1 } }) as never);
  try { await expect(readAllMessages(product, 7)).rejects.toThrow('message_identity_or_cursor_mismatch'); }
  finally { identitySpy.mockRestore(); }
  const inputSpy = spyOn(product, 'request').mockImplementation(async () => ({ ok: true, data: { sessionId: 7, items: [], nextClientSequence: 1, hasMore: true } }) as never);
  try { await expect(listAllInputs(product, 7)).rejects.toThrow('input_identity_or_cursor_mismatch'); }
  finally { inputSpy.mockRestore(); }
});
test('registered Artifact files retain exact content and are checked against manifest identity and file set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-artifact-'));
  try {
    const source = join(root, 'source'), target = join(root, 'evidence'); await mkdir(source);
    const payload = '{ "result": "ENGINEERING", "oldMetadata": { "contentHash": "historical" } }\n', files = [{ path: 'result.json', bytes: Buffer.byteLength(payload) }];
    const manifest = { contract: 'medclaw.export-manifest/v2', artifactId: 9, originOperationRef: 'operation', queryId: 5,
      answerId: null, format: 'json', exportVersion: 'medclaw.export/v2', files };
    const artifact = { id: 9, operationRef: 'operation', queryId: 5, format: 'json' as const, relativePath: 'artifacts/9',
      sizeBytes: Buffer.byteLength(payload), publishedAt: null, registeredAt: '2026-10-12T00:00:00.000Z' };
    await writeFile(join(source, 'result.json'), payload); await writeFile(join(source, 'manifest.json'), canonicalRequest(manifest));
    const copied = await copyEvidenceTree(source, target); await verifyCopiedArtifact(artifact, copied);
    expect(copied.every(file=>!('sha256' in file))).toBe(true);
    const originalManifest=await readFile(join(target,'manifest.json'),'utf8');await archiveArtifactFiles(copied);
    expect(copied.find(file=>file.relativePath==='result.json')!.content).toBe(payload);
    expect(await readFile(join(target,'manifest.json'),'utf8')).toBe(originalManifest);
    expect(copied).toHaveLength(2); expect(await readFile(join(target, 'result.json'), 'utf8')).toBe(payload);
    await expect(verifyCopiedArtifact({ ...artifact, operationRef: 'different-operation' }, copied)).rejects.toThrow('artifact_manifest_identity_mismatch');
    await writeFile(join(target,'result.json'),payload.replace('ENGINEERING','engineering'));
    await expect(verifyCopiedArtifact({...artifact,protocolValidated:true}, copied)).rejects.toThrow('artifact_content_mismatch');
    await expect(verifyCopiedArtifact(artifact, copied.filter(file=>file.relativePath!=='result.json'))).rejects.toThrow('artifact_file_set_mismatch');
    expect(() => within(source, join(root, 'outside'))).toThrow('path_outside_owned_root');
    await expect(copyEvidenceTree(source, target)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy import and export manifest metadata is read without rewriting original files', async () => {
  const root=await mkdtemp(join(tmpdir(),'medclaw-eval-legacy-artifact-'));
  try {
    for(const kind of ['import','export'] as const) {
      const source=join(root,kind),target=join(root,kind+'-evidence'),content='original content\n';await mkdir(source);
      const files=[{path:'result.json',bytes:Buffer.byteLength(content)}];
      const metadata=kind==='import'?{schema:'medclaw.artifact/import/v1',artifactId:9,operationRef:'operation',files}:null;
      const manifest=metadata?{...metadata,sourceHash:'historical',metadataHash:'historical',sourceLockHash:'historical',files:files.map(file=>({...file,sha256:'historical'}))}
        :{contract:'medclaw.export-manifest/v1',artifactId:9,originOperationRef:'operation',queryId:5,answerId:null,format:'json',exportVersion:'medclaw.export/v1',resultHash:'historical',metadataHash:'historical',files:files.map(file=>({...file,sha256:'historical'}))};
      const original=JSON.stringify(manifest,null,2)+'\n';
      await writeFile(join(source,'result.json'),content);await writeFile(join(source,'manifest.json'),original);
      const copied=await copyEvidenceTree(source,target);
      const artifact=metadata?{id:9,operationRef:'operation',status:'ready',format:'csv',mimeType:'application/x-directory',bytes:Buffer.byteLength(content),metadata}
        :{id:9,operationRef:'operation',queryId:5,format:'json',relativePath:'artifacts/9',sizeBytes:Buffer.byteLength(content),publishedAt:null,registeredAt:'2026-10-12T00:00:00.000Z'};
      await verifyCopiedArtifact(artifact as never,copied);await archiveArtifactFiles(copied);
      expect(await readFile(join(target,'manifest.json'),'utf8')).toBe(original);
      expect(copied.find(file=>file.relativePath==='manifest.json')!.content).toBe(original);
      await expect(verifyCopiedArtifact({...artifact,operationRef:'other'} as never,copied)).rejects.toThrow('artifact_manifest_identity_mismatch');
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('ENGINEERING transport observes delayed acknowledgement and exit while missing Job and save proof remain unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-delayed-stop-'));
  const product = new ProductAdapter({ dataRoot: join(root, 'product'), tracePath: join(root, 'observations.jsonl'), hostEntry: resolve(import.meta.dir, 'fixtures/delayed-transport.ts') });
  try {
    await mkdir(product.options.dataRoot); await writeFile(join(product.options.dataRoot, 'engineering-transport.json'), JSON.stringify({ ackDelayMs: 80, exitDelayMs: 80 }));
    await product.start(); expect(await product.stop(1000)).toEqual({ stopped: null, closed: true, processExited: true,
      processTreeStopped: null, requiredPersistenceComplete: null, residuals: ['process_tree_stop_unconfirmed', 'required_save_unconfirmed'] });
    expect(product.traces.some(trace => trace.kind === 'process_exit')).toBe(true);
  } finally { if (product.traces.some(trace => trace.kind === 'process_exit')) await rm(root, { recursive: true, force: true }); }
}, 30000);

test('ENGINEERING late acknowledgement or unconfirmed process exit retains owned instance and correlated evidence', async () => {
  for (const delay of [{ ackDelayMs: 200, exitDelayMs: 30 }, { ackDelayMs: 10, exitDelayMs: 200 }]) {
    const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-unknown-stop-'));
    const product = new ProductAdapter({ dataRoot: join(root, 'product'), tracePath: join(root, 'observations.jsonl'), hostEntry: resolve(import.meta.dir, 'fixtures/delayed-transport.ts'), owner: { executionId: 'engineering', trialId: 'transport', caseId: 'transport' } });
    try {
      await mkdir(product.options.dataRoot); await writeFile(join(product.options.dataRoot, 'engineering-transport.json'), JSON.stringify(delay)); await product.start();
      const body = { executionId: 'engineering', trialId: 'transport', instanceId: product.instanceId, observedFrom: new Date().toISOString(), observedUntil: new Date().toISOString(), identityChecks: [], facts: {}, missing: [] };
      const observation: VerifiedObservation = { ...body };
      const proof = await product.stop(50); expect(proof).toMatchObject({ stopped: null, closed: null, processExited: false });
      await expect(cleanupInstance({ trialRoot: root, executionId: 'engineering', trialId: 'transport', instanceId: product.instanceId, proof, observation })).rejects.toThrow('cleanup_stop_unconfirmed');
      expect(await Bun.file(join(root, 'product', 'engineering-transport.json')).exists()).toBe(true);
      expect(JSON.parse(await readFile(join(root, 'cleanup.json'), 'utf8'))).toMatchObject({ status: 'preserved', reason: 'cleanup_stop_unconfirmed' });
      const deadline = Date.now() + 3000;
      while (!product.traces.some(trace => trace.kind === 'process_exit') && Date.now() < deadline) await Bun.sleep(10);
      expect(product.traces.some(trace => trace.kind === 'process_exit')).toBe(true); await product.flush();
      if (delay.ackDelayMs > 50) {
        const request = product.traces.find(trace => trace.kind === 'request' && trace.method === 'host.shutdown');
        expect(product.traces.find(trace => trace.kind === 'late_reply')?.requestId).toBe(request?.requestId);
      }
      expect(await product.stop()).toMatchObject({ stopped: null, closed: null, processExited: true });
    } finally { if (product.traces.some(trace => trace.kind === 'process_exit')) await rm(root, { recursive: true, force: true }); }
  }
}, 30000);

test('ENGINEERING default thirty-second shutdown boundary does not accept a later acknowledgement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-eval-30s-stop-'));
  const product = new ProductAdapter({ dataRoot: join(root, 'product'), tracePath: join(root, 'observations.jsonl'), hostEntry: resolve(import.meta.dir, 'fixtures/delayed-transport.ts'), owner: { executionId: 'engineering', trialId: '30s-boundary', caseId: 'transport' } });
  await mkdir(product.options.dataRoot); await writeFile(join(product.options.dataRoot, 'engineering-transport.json'), JSON.stringify({ ackDelayMs: 31000, exitDelayMs: 30 })); await product.start();
  const started = performance.now(), proof = await product.stop();
  expect(proof).toMatchObject({ stopped: null, closed: null, processExited: false }); expect(performance.now() - started).toBeLessThan(35000);
  await writeFile(join(root, 'known-gap.json'), JSON.stringify({ contract: 'medclaw-eval-engineering-gap/v1', expectedFault: true, reason: 'fixture_ack_after_30s_boundary', proof }, null, 2));
  const deadline = Date.now() + 5000;
  while (!product.traces.some(trace => trace.kind === 'process_exit') && Date.now() < deadline) await Bun.sleep(10);
  expect(product.traces.some(trace => trace.kind === 'late_reply')).toBe(true); expect(product.traces.some(trace => trace.kind === 'process_exit')).toBe(true); await product.flush();
  const marker = JSON.parse(await readFile(join(root, 'ownership.json'), 'utf8')) as { hostPid: number };
  await writeFile(join(root, 'known-gap.json'), JSON.stringify({ contract: 'medclaw-eval-engineering-gap/v1', expectedFault: true, reason: 'fixture_ack_after_30s_boundary', proof, hostPid: marker.hostPid, processExitObserved: true }, null, 2));
  console.log(`ENGINEERING retained thirty-second boundary evidence: ${root}`);
}, 45000);
