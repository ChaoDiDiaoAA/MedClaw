import { expect,spyOn,test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { contextFixture,contextAt,acceptContextInput } from '../../../tests/fixtures/p8-context.ts';
import { openDatabase } from '../../../packages/storage/src/database.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { seedWorkspaceQueries } from '../../../tests/fixtures/p7-workspace.ts';
import { packageFixture } from '../../../tests/fixtures/snapshot-package.ts';
import { SqliteContextStore } from '../../../packages/storage/src/context-store.ts';
import { SqliteMemoryStore } from '../../../packages/storage/src/memory-store.ts';
import { SqliteToolStore } from '../../../packages/storage/src/tool-store.ts';
import { ControllerEvidenceReader } from '../../../packages/storage/src/controller-evidence.ts';
import { ModelCallRecorder } from '../../../packages/runtime-pi/src/model-call-recorder.ts';
import { validateNativeHistory } from '../../../packages/runtime-pi/src/memory-store.ts';
import { PublicMethodSchema } from '../../../packages/contracts/src/protocol.ts';
import { ControllerEvidenceInputSchema, QueryInventoryOriginalSchema } from '../../../packages/contracts/src/controller-evidence.ts';
import { QueryParamsSchema } from '../../../packages/contracts/src/query.ts';
import { canonicalRequest } from '../../../packages/contracts/src/run.ts';
import { ProductAdapter, unwrap } from '../../src/adapters/product.ts';
import { readControllerOriginal } from '../../src/adapters/controller-evidence.ts';
import { ActionExecutor } from '../../src/adapters/actions.ts';
import { prepareInstance } from '../../src/execution/instance.ts';
import type { ResolvedRunConfig } from '../../src/types.ts';

test('private query inventory returns an empty original for an authorized Run without Query facts', () => {
  const f = contextFixture();
  try {
    const reader = new ControllerEvidenceReader(f.db, new SqliteMemoryStore(f.db, validateNativeHistory), new SqliteToolStore(f.db), 'restarted-host');
    const selector = { kind: 'queries', runId: f.input.runId, sessionId: f.input.sessionId };
    const result = reader.read(ControllerEvidenceInputSchema.parse({ expectedInstanceId: 'restarted-host', ownerInstanceId: 'host', selector, offset: 0, limit: 65536 }));
    expect(JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'))).toEqual({ instanceId: 'host', runId: f.input.runId, sessionId: f.input.sessionId, queryIds: [] });
  } finally { f.dispose(); }
});

test('private Query inventory reads uncited original rows for exactly one owned Run and Session', () => {
  const f = contextFixture();
  try {
    f.db.query("UPDATE runs SET status='completed',ended_at=? WHERE id=?").run(contextAt, f.input.runId);
    const saved = seedWorkspaceQueries(f.db, f.repos), reader = new ControllerEvidenceReader(f.db,
      new SqliteMemoryStore(f.db, validateNativeHistory), new SqliteToolStore(f.db), 'restarted-host');
    const selector = { kind: 'queries' as const, runId: saved.context.runId, sessionId: saved.context.sessionId };
    const input = { expectedInstanceId: 'restarted-host', ownerInstanceId: 'host', selector, offset: 0, limit: 65536 };
    const inventory = QueryInventoryOriginalSchema.parse(JSON.parse(Buffer.from(reader.read(input).data, 'base64').toString('utf8')));
    expect(inventory).toEqual({ instanceId: 'host', runId: saved.context.runId, sessionId: saved.context.sessionId,
      queryIds: [saved.current.id, saved.secondQueryId, saved.duplicate.id] });
    const empty = reader.read({ ...input, selector: { ...selector, runId: f.input.runId } });
    expect(JSON.parse(Buffer.from(empty.data, 'base64').toString('utf8')).queryIds).toEqual([]);
    expect(f.db.query('SELECT COUNT(*) AS n FROM answers').get()).toEqual({ n: 0 });
    for (const changed of [{ ...input, ownerInstanceId: 'other' }, { ...input, expectedInstanceId: 'other' },
      { ...input, selector: { ...selector, sessionId: 2 } }, { ...input, selector: { ...selector, runId: 999 } }]) {
      expect(() => reader.read(changed)).toThrow('access_denied');
    }
    for (const queryIds of [[saved.current.id, saved.current.id], [0], [-1]]) {
      expect(QueryInventoryOriginalSchema.safeParse({ ...inventory, queryIds }).success).toBe(false);
    }
    expect(QueryInventoryOriginalSchema.safeParse({ ...inventory, sha256: 'obsolete' }).success).toBe(false);
    expect(PublicMethodSchema.safeParse('queries').success).toBe(false);
  } finally { f.dispose(); }
});

test('real Host private Query inventory finds an unaliased deterministic form Query without model execution or Workspace mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medclaw-query-inventory-')), paths: string[] = [];
  const metadata = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname; paths.push(path);
    if (path === '/api/version') return Response.json({ version: 'ENGINEERING metadata only' });
    if (path === '/api/tags') return Response.json({ models: [{ name: 'qwen3.5:0.8b' }] });
    if (path === '/api/show') return Response.json({ details: { family: 'ENGINEERING', parameter_size: 'fixture', quantization_level: 'fixture' } });
    return new Response('ENGINEERING inference prohibited', { status: 403 });
  } });
  const config: ResolvedRunConfig = { version: 1, environment: 'test', model: { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16384 },
    intent: { baseUrl: `http://127.0.0.1:${metadata.port}`, model: 'qwen3.5:0.8b' }, policy: {}, retention: 'preserve_all' };
  let product: ProductAdapter | undefined;
  try {
    packageFixture(join(root, 'inputs', 'materials', 'current'));
    product = await prepareInstance({ trialRoot: join(root, 'trial'), config });
    const executor = new ActionExecutor(product, config, join(root, 'inputs'), join(root, 'trial'));
    await executor.execute({ action: 'new_session', alias: 'A' }); await executor.execute({ action: 'import', alias: 'snapshot', materialRef: 'materials/current' });
    await executor.execute({ action: 'select_workspace', batchAliases: ['snapshot:batch:1', 'snapshot:batch:2'] });
    const workspace = unwrap(await product.request('workspace.read', {})), sessionId = executor.aliases.sessions.get('A')!.id;
    const params = QueryParamsSchema.parse({ kind: 'current', population: 'snapshot', snapshotMode: 'exact_date', batchIds: workspace.batchRefs.map(batch => batch.id),
      time: { start: '2026-01-02', endExclusive: '2026-01-03' } });
    const accepted = unwrap(await product.request('session.submit', { sessionId, clientSequence: 1, text: 'Query form: ' + canonicalRequest(params), mode: 'send',
      routing: { mode: 'user_form', params }, expectedRevision: workspace.revision, expectedBatchIds: params.batchIds, expectedQueryId: null,
      model: { provider: config.model.provider, modelId: config.model.model, expectedConfigVersion: unwrap(await product.request('model.config.read', {})).configVersion },
      referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' }));
    if (accepted.runId === null) throw new Error('form_run_missing');
    executor.aliases.runs.set('form', accepted.runId); await executor.wait('run_settled', 'form', 10000); executor.aliases.queries.clear();
    const other = unwrap(await product.request('workspace.read', {}));
    await executor.execute({ action: 'new_session', alias: 'B' });
    const before = unwrap(await product.request('workspace.read', {})); expect(before.sessionId).not.toBe(sessionId);
    const inventory = await readControllerOriginal(product, { kind: 'queries', runId: accepted.runId, sessionId });
    expect(inventory.protocolValidated).toBe(true);
    expect(QueryInventoryOriginalSchema.parse(inventory.original)).toEqual({ instanceId: product.instanceId, runId: accepted.runId, sessionId, queryIds: [1] });
    expect(unwrap(await product.request('workspace.read', {}))).toEqual(before);
    expect(other.sessionId).toBe(sessionId); expect(executor.aliases.queries.size).toBe(0);
    expect(unwrap(await product.request('run.read', { runId: accepted.runId }))).toMatchObject({ kind: 'one', run: { calls: [] } });
    let failure: unknown;
    try { await readControllerOriginal(product, { kind: 'queries', runId: accepted.runId, sessionId }, 'other-owner'); } catch (error) { failure = error; }
    expect(failure instanceof Error ? failure.message : null).toBe('access_denied');
  } finally {
    if (product) expect(await product.stop()).toMatchObject({ stopped: true, closed: true, processExited: true });
    metadata.stop(true); expect(paths.every(path => ['/api/version', '/api/tags', '/api/show'].includes(path))).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test('Host storage and Adapter round-trip a large SDK original with paging and original owner after restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'medclaw-controller-original-')),db=openDatabase(join(root,'app.sqlite')),manager=SessionManager.inMemory(root);
  const header=manager.getHeader()!,f={db,...acceptContextInput(db,{nativeSessionId:header.id,initialHistory:{header,entries:[],activeLeafId:null}})};
  const product=new ProductAdapter({dataRoot:root,tracePath:join(root,'unused-controller-trace')});product.instanceId='restarted-host';
  try {
    const memory=new SqliteMemoryStore(f.db,validateNativeHistory),history=unwrap(await memory.load(f.input.sessionId));
    unwrap(await memory.commit({sessionId:f.input.sessionId,runId:f.input.runId,expectedStorageVersion:history.storageVersion,header:history.header,
      newEntries:[{id:f.input.nativeEntryId,parentId:history.activeLeafId,type:'message',timestamp:contextAt,message:{role:'user',content:f.content.text,timestamp:Date.parse(contextAt)}}],activeLeafId:f.input.nativeEntryId}));
    const contexts=new SqliteContextStore(f.db),snapshot=contexts.save(contexts.select(f.input));
    const recorder=new ModelCallRecorder(f.repos,f.input.runId,'main',contextAt,{snapshotId:snapshot.id,inputId:f.input.inputId});
    const payload={messages:[{role:'user',content:'完整原件'.repeat(40000)}],tools:[]};recorder.recordPayload(payload,contextAt);
    const reader=new ControllerEvidenceReader(f.db,new SqliteMemoryStore(f.db,validateNativeHistory),new SqliteToolStore(f.db),'restarted-host');
    let pages=0;const spy=spyOn(product,'request').mockImplementation(async(_method:string,input:unknown)=>{pages++;return {ok:true,data:reader.read(ControllerEvidenceInputSchema.parse(input))} as never;});
    const selector={kind:'request' as const,runId:f.input.runId,sessionId:f.input.sessionId,callId:recorder.callId};
    try {
      const original=await readControllerOriginal(product,selector,'host');expect(pages).toBeGreaterThan(3);
      expect(JSON.parse(original.original[0].body)).toEqual(payload);expect(original.original[0].boundary).toBe('sdk_onPayload');
      await expect(readControllerOriginal(product,selector,'other-host')).rejects.toThrow('access_denied');
      await expect(readControllerOriginal(product,{...selector,callId:'missing'},'host')).rejects.toThrow('evidence_not_found');
      f.db.query('UPDATE model_calls SET model_json=json_set(model_json,?,?) WHERE call_id=?').run('$.requestOriginals[0].callId','wrong-call',recorder.callId);
      await expect(readControllerOriginal(product,selector,'host')).rejects.toThrow('evidence_integrity_failed');
    } finally {spy.mockRestore();}
  } finally {db.close();await rm(root,{recursive:true,force:true});}
});

test('controller transport rejects crossed identity, damaged bytes, truncation and cursors; public callers have no method',async()=>{
  const product=new ProductAdapter({dataRoot:tmpdir(),tracePath:join(tmpdir(),'unused-controller-trace')});product.instanceId='host';
  const selector={kind:'run' as const,runId:1,sessionId:1};
  for(const corruption of ['owner','utf8','json','truncated','cursor','base64'] as const) {
    const data=corruption==='base64'?'!!!!':(corruption==='utf8'?Buffer.from([0xff,0xff]):Buffer.from(corruption==='truncated'?'{':corruption==='json'?'}{':'{}')).toString('base64');
    const spy=spyOn(product,'request').mockImplementation(async()=>({ok:true,data:{instanceId:'host',ownerInstanceId:corruption==='owner'?'wrong':'host',selector,bytes:2,offset:0,nextOffset:corruption==='cursor'?1:null,encoding:'base64',data}}) as never);
    try {await expect(readControllerOriginal(product,selector)).rejects.toThrow();}finally{spy.mockRestore();}
  }
  expect(PublicMethodSchema.safeParse('controller.evidence.read').success).toBe(false);
  expect(ControllerEvidenceInputSchema.safeParse({expectedInstanceId:'host',ownerInstanceId:'host',selector:{kind:'file',path:'C:/secret'},offset:0,limit:10}).success).toBe(false);
});
