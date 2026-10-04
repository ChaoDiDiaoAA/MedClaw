import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HostController } from '../../apps/desktop/src/main/host-controller';
import { FileTokens } from '../../apps/desktop/src/main/file-tokens';
import { MainSettings, atomicWriteJson } from '../../apps/desktop/src/main/settings';
import { TOOL_CONFIG, type ToolConfiguration } from '../../packages/contracts/src/tool-config';
import { mergeRuntimeConfigurationPolicies } from '../../packages/contracts/src/runtime-config';
import { PublishedSettingsSchema } from '../../packages/contracts/src/model';
import { DATABASE_SCHEMA_VERSION, type PrivateCredentialFrame } from '../../packages/contracts/src/protocol';
import { ImportPreviewSchema, ImportOperationSchema } from '../../packages/contracts/src/data';
import { NewSessionResultSchema, SessionDetailSchema, SessionInputPageSchema, SubmitResultSchema, type SubmitInput } from '../../packages/contracts/src/session';
import { WorkspaceViewSchema } from '../../packages/contracts/src/workspace';
import { RuntimeControlViewSchema, ReadRunResultSchema } from '../../packages/contracts/src/run';
import { safeError, type Result } from '../../packages/contracts/src/error';
import { QueryParamsSchema, QueryViewSchema } from '../../packages/contracts/src/query';
import { SessionMessagePageSchema } from '../../packages/contracts/src/messages';

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function sendResult(value: unknown) {
  const result = SubmitResultSchema.parse(value);
  expect(result.runId !== null).toBe(true);
  expect(result.inputId !== null).toBe(true);
  if (result.runId === null || result.inputId === null) throw new Error('Current Send acceptance requires root Run and input identities');
  return { ...result, runId: result.runId, inputId: result.inputId };
}
async function until(check: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error('Host condition timed out'); await Bun.sleep(20); }
}
function singleDayPackage(root: string) {
  mkdirSync(root);
  const input = resolve('data/agent-input');
  for (const name of ['entity-lineage.csv', 'source-lock.json', 'adjustment-lineage.csv', 'validation-report.json', 'selection-report.json', '使用说明.md', 'zhejiang_2026-01-01.csv', 'zhejiang_2026-01-01.metadata.json']) copyFileSync(join(input, name), join(root, name));
  const files = readdirSync(root).sort().map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ status: 'complete', files, businessFiles: 1, businessRows: 813, businessBytes: files.find(file => file.path === 'zhejiang_2026-01-01.csv')!.bytes, totalPayloadBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}
async function setup(holdFinal = false, configuration: ToolConfiguration = structuredClone(TOOL_CONFIG)) {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p3-host-')), source = join(root, 'source'); singleDayPackage(source);
  const requests: Record<string, unknown>[] = [], privateRequests: PrivateCredentialFrame[] = [];
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>; requests.push(body);
    const messages = body.messages as { role: string }[];
    const toolReturned = messages.some(message => message.role === 'tool');
    if (toolReturned && holdFinal) await finalGate;
    const chunks = toolReturned
      ? [{ id: 'p3-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'There are 813 devices in the imported snapshot.' }, finish_reason: 'stop' }] }]
      : [{ id: 'p3-fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'current-call', type: 'function', function: { name: 'query_current_devices', arguments: JSON.stringify({ batchIds: [1], time: { start: '2026-01-01', endExclusive: '2026-01-02' } }) } }] }, finish_reason: 'tool_calls' }] }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const tokens = new FileTokens(), host = new HostController({ dataRoot: root, hostEntry: resolve('apps/host/src/main.ts'), bunExecutable: process.execPath, onCredentialRequest: async frame => {
    privateRequests.push(frame);
    if (frame.method === 'file.resolve') {
      try { return { ok: true, data: tokens.resolve(frame.payload.fileToken, 7, host.read().instanceId!, frame.payload.operationRef) }; }
      catch { return { ok: false, error: safeError('file_token_invalid') }; }
    }
    if (frame.method === 'credential.list') return { ok: true, data: [{ providerId: 'p3-fixture', type: 'api_key' }] };
    if (frame.method === 'credential.read') return { ok: true, data: frame.payload.providerId === 'p3-fixture' ? { type: 'api_key', key: 'fixture-only' } : null };
    return { ok: false, error: safeError('access_denied') };
  } });
  const settings = new MainSettings(host.paths.settingsPath).read();
  atomicWriteJson(host.paths.settingsPath, PublishedSettingsSchema.parse({ ...settings, model: { provider: 'p3-fixture', modelId: 'fixture' }, customProviders: [{ credentialRef: null, definition: { providerId: 'p3-fixture', name: 'Fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.port}/v1`, models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32768, maxTokens: 1024, outputLimitConfirmed: true, pricingKnown: false, cost: null }] } }], toolConfiguration: configuration, ...mergeRuntimeConfigurationPolicies(settings, { requestPolicy: { timeoutMs: 10000, maxRetries: 0, maxRetryDelayMs: 2000 } }) }));
  expect(await host.start()).toMatchObject({ state: 'ready', schemaVersion: DATABASE_SCHEMA_VERSION, error: null });
  const issue = (operationRef: string) => tokens.issue(7, host.read().instanceId!, operationRef, source).fileToken;
  const workspace = async () => WorkspaceViewSchema.parse(unwrap(await host.request('workspace.read', {})));
  const preview = async (operationRef: string, fileToken = issue(operationRef)) => ({ fileToken, preview: ImportPreviewSchema.parse(unwrap(await host.request('import.preview', { operationRef, fileToken, mappingVersion: 'medclaw.snapshot/v1' }, operationRef))) });
  const close = async () => { releaseFinal(); try { if (host.read().instanceId && !host.read().canStart) await host.stop(host.read().instanceId!); } finally { provider.stop(true); rmSync(root, { recursive: true, force: true }); } };
  const publisher = new MainSettings(host.paths.settingsPath, {
    prepare: async (token, candidate) => unwrap(await host.request('settings.prepare', { token, candidate })),
    commit: async (token, publishedVersion) => unwrap(await host.request('settings.commit', { token, publishedVersion })),
    abort: async token => unwrap(await host.request('settings.abort', { token })),
  });
  return { root, source, host, tokens, issue, workspace, preview, requests, privateRequests, close, releaseFinal, publisher };
}

test('P3 production Host imports through Main tokens, freezes trusted scope and executes an actual Pi business tool', async () => {
  const f = await setup(); try {
    const { preview, fileToken } = await f.preview('import-1'); expect(preview).toMatchObject({ canCommit: true, rowCount: 813, entityCount: 813, batchCount: 1 });
    const before = await f.workspace(); expect(before.batchRefs).toEqual([]);
    const result = ImportOperationSchema.parse(unwrap(await f.host.request('import.commit', { operationRef: 'import-1', previewHash: preview.previewHash, fileToken }, 'import-1')));
    expect(result.state).toBe('imported'); expect(result.result?.acceptedRows).toBe(813);
    expect((await f.workspace()).batchRefs).toEqual([]); expect(f.requests).toHaveLength(0);
    const session = NewSessionResultSchema.parse(unwrap(await f.host.request('session.create', { expectedWorkspaceRevision: (await f.workspace()).revision }, 'new-session')));
    const selected = WorkspaceViewSchema.parse(unwrap(await f.host.request('workspace.update', { expectedRevision: (await f.workspace()).revision, change: { batchIds: result.result!.batchIds } }, 'select-data')));
    expect(selected.batchRefs.map(batch => batch.id)).toEqual([1]);
    const detail = SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: session.session.id })));
    const input = { sessionId: session.session.id, clientSequence: detail.session.nextSubmissionSequence, text: 'List the imported devices on 2026-01-01.', mode: 'send', expectedRevision: selected.revision, expectedBatchIds: [1], expectedQueryId: null, model: { provider: 'p3-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' };
    await expect(f.host.request('session.submit', { ...input, referenceDate: '2026-02-30' }, 'invalid-date')).rejects.toThrow('Expected a real YYYY-MM-DD date');
    expect(await f.host.request('session.submit', { ...input, timezone: 'UTC' }, 'mismatched-timezone')).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    expect(f.requests).toHaveLength(0);
    const accepted = sendResult(unwrap(await f.host.request('session.submit', input, 'ask-devices')));
    await until(async () => RuntimeControlViewSchema.parse(unwrap(await f.host.request('run.control.read', {}))).acceptingNewRuns);
    const run = ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: accepted.runId }))); expect(run).toMatchObject({ kind: 'one', run: { status: 'completed', inputId: accepted.inputId, referenceDate: '2026-01-02', timezone: 'Asia/Shanghai' } });
    expect(await f.host.request('session.submit', { ...input, referenceDate: '2026-01-01' }, 'ask-devices')).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.host.request('session.submit', input, 'ask-devices')).toMatchObject({ ok: true, data: accepted });
    expect(f.requests).toHaveLength(2);
    const tools = f.requests[0]!.tools as { function: { name: string } }[]; expect(tools).toHaveLength(23); expect(tools.some(tool => tool.function.name === 'query_current_devices')).toBe(true);
    const messages = f.requests[1]!.messages as { role: string; content: string }[];
    expect(JSON.parse(messages.find(message => message.role === 'tool')!.content)).toMatchObject({ queryId: 1, totalRows: 813, interpretation: { referenceDate: '2026-01-02', requestedDate: '2026-01-01', dataDates: ['2026-01-01'], isStale: false } });
    const db = new Database(f.host.paths.databasePath, { readonly: true }); try {
      expect(db.query('SELECT input_id FROM runs').all()).toEqual([{ input_id: accepted.inputId }]);
      expect(db.query('SELECT input_id FROM model_calls ORDER BY id').all()).toEqual([{ input_id: accepted.inputId }, { input_id: accepted.inputId }]);
      expect(db.query('SELECT input_id FROM queries').all()).toEqual([{ input_id: accepted.inputId }]);
      expect(db.query('SELECT input_id FROM answers').all()).toEqual([{ input_id: accepted.inputId }]);
      expect(db.query('SELECT tool_name,status FROM tool_calls').all()).toEqual([{ tool_name: 'query_current_devices', status: 'succeeded' }]);
      expect(db.query('SELECT source FROM queries').all()).toEqual([{ source: 'agent_tool' }]);
      expect(db.query('SELECT count(*) n FROM query_evidence').get()).toEqual({ n: 1 });
      expect(db.query('SELECT reference_date, json_extract(config_json, \'$.referenceDate\') config_reference_date FROM runs').all()).toEqual([{ reference_date: '2026-01-02', config_reference_date: '2026-01-02' }]);
      const original = { run: db.query('SELECT * FROM runs').all(), query: db.query('SELECT * FROM queries').all(), evidence: db.query('SELECT * FROM query_evidence').all(), answer: db.query('SELECT * FROM answers').all(), tool: db.query('SELECT * FROM tool_calls').all() };
      const page = SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read', { sessionId: session.session.id })));
      const receipt = page.items.find(item => item.displayRole === 'tool_result');
      expect(receipt).toMatchObject({ toolCallRef: 'current-call', runId: accepted.runId, references: [`run:${accepted.runId}`, 'tool:1', 'query:1', 'evidence:1'] });
      expect(db.query("SELECT json_extract(delivery_json,'$.nativeEntryId') entry FROM tool_calls").get()).toEqual({ entry: receipt!.nativeEntryId });
      const view = unwrap(await f.host.request('tool.read', { runId: accepted.runId })) as { items: { inputPreview: string; resultPreview: string; nativeOutputTruncated: boolean | null }[] };
      expect(view.items[0]).toMatchObject({ inputPreview: 'query_current_devices: arguments omitted', resultPreview: 'query_current_devices: saved result succeeded', nativeOutputTruncated: null });
      expect(JSON.stringify(view)).not.toContain('813');
      expect({ run: db.query('SELECT * FROM runs').all(), query: db.query('SELECT * FROM queries').all(), evidence: db.query('SELECT * FROM query_evidence').all(), answer: db.query('SELECT * FROM answers').all(), tool: db.query('SELECT * FROM tool_calls').all() }).toEqual(original);
      expect(db.query('SELECT native_leaf_id FROM answers').all()).toEqual([{ native_leaf_id: null }]);
      expect(f.requests).toHaveLength(2);
    } finally { db.close(); }
    renameSync(f.source, `${f.source}-moved`);
    expect(await f.host.request('import.recover', { operationRef: 'import-1' })).toMatchObject({ ok: true, data: { state: 'imported' } });
    const old = f.host.read().instanceId!; expect(await f.host.restart(old)).toMatchObject({ state: 'ready', schemaVersion: DATABASE_SCHEMA_VERSION, error: null });
    expect(await f.host.request('import.read', { operationRef: 'import-1' })).toMatchObject({ ok: true, data: { state: 'imported' } });
  } finally { await f.close(); }
}, 30000);

test('manual Query and native Steer Follow Up retain the original P3 Run and frozen input identity after policy publication', async () => {
  const configuration = structuredClone(TOOL_CONFIG);
  const f = await setup(true, configuration); try {
    const { preview, fileToken } = await f.preview('import');
    const imported = ImportOperationSchema.parse(unwrap(await f.host.request('import.commit', { operationRef: 'import', previewHash: preview.previewHash, fileToken }, 'import')));
    const session = NewSessionResultSchema.parse(unwrap(await f.host.request('session.create', { expectedWorkspaceRevision: (await f.workspace()).revision }, 'session-a')));
    const selected = WorkspaceViewSchema.parse(unwrap(await f.host.request('workspace.update', { expectedRevision: (await f.workspace()).revision, change: { batchIds: imported.result!.batchIds } })));
    const params = { kind: 'aggregate', population: 'snapshot', snapshotMode: 'exact_date', batchIds: [1], metric: 'count' };
    expect(await f.host.request('query.execute', { params, expectedRevision: selected.revision }, 'before-run')).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const accepted = sendResult(unwrap(await f.host.request('session.submit', { sessionId: session.session.id, clientSequence: 1, text: 'List imported devices.', mode: 'send',
      expectedRevision: selected.revision, expectedBatchIds: [1], expectedQueryId: null, model: { provider: 'p3-fixture', modelId: 'fixture', expectedConfigVersion: '1' }, referenceDate: '2026-01-01', timezone: 'Asia/Shanghai' }, 'ask')));
    await until(async () => f.requests.length === 2);
    const root = ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: accepted.runId })));
    if (root.kind !== 'one' || root.run === null || root.run.kind !== 'agent') throw new Error('Active root Agent Run must exist');
    const frozen = root.run;
    expect(frozen.model.configVersion).toBe('1');
    const nextConfiguration = structuredClone(configuration);
    await f.publisher.publish('1', { toolConfiguration: nextConfiguration }, { kind: 'policy' });
    expect(f.publisher.read().configVersion).toBe('2');
    const request = { params, expectedRevision: selected.revision };
    const manual = QueryViewSchema.parse(unwrap(await f.host.request('query.execute', request, 'manual-query')));
    expect(manual).toMatchObject({ query: { runId: accepted.runId, sessionId: session.session.id, source: 'user_form', callRef: `${accepted.runId}:manual-query`, totalRows: 1 }, page: { rows: [{ value: 813 }] } });
    expect(manual.query.params).toMatchObject({ pageSize: 50, sort: 'asc' });
    expect(manual.page.pageSize).toBe(50);
    const savedEvidence = new Database(f.host.paths.databasePath);
    try {
      savedEvidence.query(`INSERT INTO query_evidence(query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,
        calculation_version,material_version,source_bundle_id,source_lock_hash,result_hash,filters_json,provenance)
        SELECT query_id,batch_ids_json,snapshot_ids_json,event_ids_json,source_row_refs_json,
        calculation_version,material_version,source_bundle_id,source_lock_hash,result_hash,filters_json,provenance
        FROM query_evidence WHERE query_id=? LIMIT 1`).run(manual.query.id);
    } finally { savedEvidence.close(); }
    expect(QueryViewSchema.parse(unwrap(await f.host.request('query.execute', request, 'manual-query'))).evidence).toHaveLength(2);
    expect(QueryViewSchema.parse(unwrap(await f.host.request('query.read', { queryId: manual.query.id }))).evidence).toHaveLength(2);
    expect('rows' in manual.query).toBe(false);
    expect('snapshotIds' in manual.query).toBe(false);
    expect(f.requests).toHaveLength(2);
    const queuedIds: number[] = [];
    for (const [mode, text, operation] of [['steer', 'Keep the original aggregate scope.', 'queued-steer'], ['follow_up', 'Then confirm the original device scope.', 'queued-follow']] as const) {
      const detail = SessionDetailSchema.parse(unwrap(await f.host.request('session.read', { sessionId: session.session.id })));
      const current = await f.workspace();
      const input: SubmitInput = { sessionId: session.session.id, clientSequence: detail.session.nextSubmissionSequence, mode, text, targetRunId: accepted.runId,
        expectedRevision: current.revision, expectedBatchIds: current.batchRefs.map(batch => batch.id), expectedQueryId: current.queryId,
        model: { provider: frozen.model.provider, modelId: frozen.model.modelId, expectedConfigVersion: frozen.model.configVersion }, referenceDate: frozen.referenceDate, timezone: frozen.timezone };
      const queued = SubmitResultSchema.parse(unwrap(await f.host.request('session.submit', input, operation)));
      expect(queued.runId).toBeNull(); expect(queued.inputId !== null).toBe(true);
      if (queued.inputId === null) throw new Error('Queued input requires accepted identity'); queuedIds.push(queued.inputId);
    }
    expect(f.requests).toHaveLength(2);
    f.releaseFinal();
    await until(async () => RuntimeControlViewSchema.parse(unwrap(await f.host.request('run.control.read', {}))).acceptingNewRuns);
    const inputs = SessionInputPageSchema.parse(unwrap(await f.host.request('session.listInputs', { sessionId: session.session.id }))).items;
    expect(inputs.map(input => [input.id, input.status, input.processingStatus, input.runId])).toEqual([[accepted.inputId, 'consumed', 'completed', accepted.runId], [queuedIds[0], 'consumed', 'completed', accepted.runId], [queuedIds[1], 'consumed', 'completed', accepted.runId]]);
    expect(new Set(inputs.map(input => input.nativeEntryId)).size).toBe(3); expect(inputs.every(input => input.nativeEntryId !== null)).toBe(true);
    const history = SessionMessagePageSchema.parse(unwrap(await f.host.request('session.messages.read', { sessionId: session.session.id })));
    const users = history.items.filter(item => item.displayRole === 'user');
    expect(users.map(item => [item.inputId, item.nativeEntryId, item.text])).toEqual([[accepted.inputId, inputs[0]!.nativeEntryId, 'List imported devices.'], [queuedIds[0], inputs[1]!.nativeEntryId, 'Keep the original aggregate scope.'], [queuedIds[1], inputs[2]!.nativeEntryId, 'Then confirm the original device scope.']]);
    expect(history.items.filter(item => item.displayRole === 'assistant' || item.displayRole === 'tool_result').every(item => item.inputId === null)).toBe(true);
    const linked = new Database(f.host.paths.databasePath, { readonly: true });
    try {
      expect(linked.query('SELECT id,input_id FROM runs').all()).toEqual([{ id: accepted.runId, input_id: accepted.inputId }]);
      expect(linked.query('SELECT input_id FROM model_calls ORDER BY id').all()).toEqual(Array.from({ length: 4 }, () => ({ input_id: accepted.inputId })));
      expect(linked.query('SELECT source,input_id FROM queries ORDER BY id').all()).toEqual([{ source: 'agent_tool', input_id: accepted.inputId }, { source: 'user_form', input_id: accepted.inputId }]);
      expect(linked.query('SELECT run_id,input_id FROM answers').all()).toEqual([{ run_id: accepted.runId, input_id: accepted.inputId }]);
    } finally { linked.close(); }
    const completed = ReadRunResultSchema.parse(unwrap(await f.host.request('run.read', { runId: accepted.runId })));
    expect(completed).toMatchObject({ kind: 'one', run: { status: 'completed', model: frozen.model, inputId: accepted.inputId, referenceDate: frozen.referenceDate, timezone: frozen.timezone } });
    expect(f.requests).toHaveLength(4);
    const settledRequestCount = f.requests.length;
    console.info(JSON.stringify({ evidence: 'A14 actual Host', runId: accepted.runId, rootInputId: accepted.inputId, inputEntries: users.map(item => ({ inputId: item.inputId, nativeEntryId: item.nativeEntryId })), httpRequests: settledRequestCount, modelCalls: 4, queries: 2, answers: 1, frozenConfigVersion: frozen.model.configVersion, publishedConfigVersion: f.publisher.read().configVersion }));
    expect(QueryViewSchema.parse(unwrap(await f.host.request('query.execute', request, 'manual-query'))).query).toEqual(manual.query);
    expect(await f.host.request('query.execute', { ...request, expectedRevision: selected.revision + 1 }, 'manual-query')).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(QueryViewSchema.parse(unwrap(await f.host.request('query.read', { queryId: manual.query.id }))).query.resultHash).toBe(manual.query.resultHash);
    const next = NewSessionResultSchema.parse(unwrap(await f.host.request('session.create', { expectedWorkspaceRevision: (await f.workspace()).revision }, 'session-b')));
    expect(next.workspace.queryId).toBeNull();
    expect(QueryViewSchema.parse(unwrap(await f.host.request('query.read', { queryId: manual.query.id }))).query).toEqual(manual.query);
    expect(await f.host.request('workspace.update', { expectedRevision: next.workspace.revision, change: { queryId: manual.query.id } })).toMatchObject({ ok: false, error: { code: 'access_denied' } });
    expect(await f.workspace()).toEqual(next.workspace);
    expect(await f.host.request('tool.read', { runId: accepted.runId })).toMatchObject({ ok: true, data: { runId: accepted.runId, scope: { batchIds: [1] }, items: [{ name: 'query_current_devices', status: 'succeeded' }] } });
    expect(f.requests).toHaveLength(settledRequestCount);
  } finally { await f.close(); }
}, 30000);

test('P3 Host rejects forged directory paths, mismatched operation identities and old Host tokens', async () => {
  const f = await setup(); try {
    const token = f.issue('original');
    expect(await f.host.request('import.preview', { operationRef: 'original', fileToken: token, mappingVersion: 'medclaw.snapshot/v1' }, 'other-envelope')).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    expect(await f.host.request('import.read', { operationRef: 'original' })).toEqual({ ok: true, data: null });
    await expect(f.host.request('import.preview', { operationRef: 'extra-path', fileToken: token, mappingVersion: 'medclaw.snapshot/v1', directory: f.source }, 'extra-path')).rejects.toThrow();
    expect(await f.host.request('import.preview', { operationRef: 'wrong-token-operation', fileToken: token, mappingVersion: 'medclaw.snapshot/v1' }, 'wrong-token-operation')).toMatchObject({ ok: false, error: { code: 'file_token_invalid' } });
    await expect(f.host.request('import.preview', { operationRef: 'raw-path', fileToken: f.source, mappingVersion: 'medclaw.snapshot/v1' }, 'raw-path')).rejects.toThrow();
    const old = f.host.read().instanceId!; await f.host.restart(old);
    expect(await f.host.request('import.preview', { operationRef: 'original', fileToken: token, mappingVersion: 'medclaw.snapshot/v1' }, 'original')).toMatchObject({ ok: false, error: { code: 'file_token_invalid' } });
    expect(f.requests).toHaveLength(0);
    expect(f.privateRequests.filter(frame => frame.method === 'file.resolve').every(frame => frame.secret)).toBe(true);
    const db = new Database(f.host.paths.databasePath, { readonly: true }); try { expect(db.query('SELECT count(*) n FROM batches').get()).toEqual({ n: 0 }); expect(db.query('SELECT count(*) n FROM runs').get()).toEqual({ n: 0 }); } finally { db.close(); }
  } finally { await f.close(); }
}, 30000);
