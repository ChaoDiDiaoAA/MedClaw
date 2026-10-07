import { expect, test } from 'bun:test';
import { PublishedSettingsSchema, SETTINGS_SCHEMA_VERSION, SDK_VERSION } from '../../packages/contracts/src/model';
import { DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION, PublicHostRequestSchema, isReadOnlyMethod, publicMethodSchemas } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';
import { ExtensionManifestSchema, ExtensionAssemblyProofSchema, FrozenRunExtensionsSchema, type FrozenRunExtensions, type ExtensionAssemblyProof } from '../../packages/contracts/src/extensions';
import { createToolControlObservation, ToolControlObservationSchema } from '../../packages/contracts/src/model';
import { canonicalRequest, type RunCleanupRecord } from '../../packages/contracts/src/run';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../packages/storage/src/database';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptContextInput } from '../fixtures/p8-context';

const settings = { schemaVersion: SETTINGS_SCHEMA_VERSION, configVersion: '1', model: null, customProviders: [], credentialRefs: {}, previous: null, rollbackFromVersion: null };
const ref = { id: 'tool-audit' as const, version: 'v1' as const, treeHash: 'a'.repeat(64) };

test('p12 old settings remain absent while explicit per-session selections survive normalization', () => {
  expect(PublishedSettingsSchema.parse(settings)).not.toHaveProperty('extensions');
  const extensions = { bySession: { '1': { extension: ref }, '2': { extension: null } } };
  expect(PublishedSettingsSchema.safeParse({ ...settings, extensions }).success).toBe(true);
  expect(PublishedSettingsSchema.parse({ ...settings, extensions })).toHaveProperty('extensions', extensions);
  for (const key of ['0', '01', '-1', '9007199254740992']) expect(PublishedSettingsSchema.safeParse({ ...settings, extensions: { bySession: { [key]: { extension: null } } } }).success).toBe(false);
  expect(PublishedSettingsSchema.safeParse({ ...settings, extensions: { bySession: { '1': { extension: { ...ref, path: 'untrusted.ts' } } } } }).success).toBe(false);
});

test('p12 public strict methods preserve original owner and reject old host frames', () => {
  const methods: Record<string, { input: { safeParse(input: unknown): { success: boolean } } }> = publicMethodSchemas;
  expect(methods['extensions.select']).toBeDefined();
  const input = { sessionId: 1, expectedConfigVersion: '1', selection: { extension: ref } };
  expect(methods['extensions.select']!.input.safeParse(input).success).toBe(true);
  const owner = { instanceId: 'host', sessionId: 1, runId: 2, assemblyId: 'assembly' };
  expect(methods['extensions.command']!.input.safeParse({ ...owner, command: 'extension_status' }).success).toBe(true);
  expect(methods['extensions.command']!.input.safeParse({ ...owner, command: 'install' }).success).toBe(false);
  expect(methods['extensions.read']!.input.safeParse({ source: 'run', runId: 2, sessionId: 3 }).success).toBe(false);
  const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'r', instanceId: 'host', operationRef: 'extensions', method: 'extensions.select', payload: input };
  expect(PublicHostRequestSchema.safeParse(frame).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p11-v1' }).success).toBe(false);
  expect(isReadOnlyMethod('extensions.command')).toBe(true); expect(isReadOnlyMethod('extensions.select')).toBe(false);
  expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p13-v1'); expect(DATABASE_SCHEMA_VERSION).toBe(12); expect(SDK_VERSION).toBe('0.87.1');
});

test('p12 extension failures are safe non-retryable errors with the original identity', () => {
  for (const code of ['extension_unavailable', 'extension_conflict', 'extension_hook_failed', 'extension_cleanup_failed', 'extension_command_failed']) {
    const error = safeError(code, new Error('PRIVATE_PATH SECRET'), { runId: 2, sessionId: 1 });
    expect(error).toMatchObject({ code, category: 'extension', retryable: false, runId: 2, sessionId: 1 });
    expect(error.message).not.toContain('PRIVATE');
  }
});

function frozenExtension(): FrozenRunExtensions {
  const manifest = ExtensionManifestSchema.parse({ contract: 'medclaw.extension-manifest/v1', id: 'tool-audit', version: 'v1', sdkVersion: '0.87.1', entry: 'index.ts', files: ['manifest.json', 'index.ts'],
    hooks: { critical: ['session_start', 'tool_call'], observation: ['input', 'context', 'tool_result', 'agent_start', 'agent_end'] }, tools: ['extension_runtime_status'], commands: ['extension_status'] });
  const files = ([['manifest.json', JSON.stringify(manifest)], ['index.ts', 'export const createToolAudit=()=>{};']] as const)
    .map(([file, content]) => ({ file, content, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }));
  const metadata = { id: manifest.id, version: manifest.version, sdkVersion: manifest.sdkVersion, files: files.map(({file,bytes,sha256}) => ({file,bytes,sha256})).sort((a,b) => a.file.localeCompare(b.file)) };
  return FrozenRunExtensionsSchema.parse({ contract: 'medclaw.run-extensions/v1', sdkVersion: '0.87.1', sessionId: 1, configVersion: '1',
    selection: { extension: { ...ref, treeHash: createHash('sha256').update(canonicalRequest(metadata)).digest('hex') } }, source: { manifest, files } });
}

test('p12 assembly proof distinguishes loaded, failed and actually released facts', () => {
  const clean = { instanceId: 'host', sessionId: 1, runId: 1, assemblyId: 'a', contract: 'medclaw.extension-assembly/v1', ref, state: 'active', loadedAt: '2026-10-06T00:00:00.000Z', disposedAt: null,
    callableTools: ['extension_runtime_status'], callableCommands: ['extension_status'], hookCounts: { input: 0, context: 0, tool_call: 0, tool_result: 0 }, resourcesReleased: false, diagnostics: [] };
  expect(ExtensionAssemblyProofSchema.safeParse(clean).success).toBe(true);
  for (const patch of [{ loadedAt: null }, { callableTools: [] }, { resourcesReleased: true }, { state: 'disposed' }]) expect(ExtensionAssemblyProofSchema.safeParse({ ...clean, ...patch }).success).toBe(false);
  expect(ExtensionAssemblyProofSchema.safeParse({ ...clean, state: 'disposed', resourcesReleased: true, disposedAt: '2026-10-06T00:00:01.000Z' }).success).toBe(true);
  const control = createToolControlObservation(); expect(ToolControlObservationSchema.parse(control)).not.toHaveProperty('hookInput');
  expect(ToolControlObservationSchema.safeParse({ ...control, hookInput: { beforeSha256: ref.treeHash, afterSha256: ref.treeHash, changed: true } }).success).toBe(false);
});

test('p12 run freeze is saved in the input transaction and corrupt original evidence fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-store-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const frozen = frozenExtension(), { repos, accepted } = acceptContextInput(db, { extensions: frozen });
    expect(repos.readRunExtensions(accepted.runId!)).toEqual(frozen);
    const row = db.query<{config_json:string},[number]>('SELECT config_json FROM runs WHERE id=?').get(accepted.runId!)!;
    const config = JSON.parse(row.config_json);
    for (const corrupt of [{ ...frozen, sessionId: 2 }, { ...frozen, configVersion: '2' }, { ...frozen, selection: { extension: ref } },
      { ...frozen, source: { ...frozen.source!, files: frozen.source!.files.map(file => file.file === 'index.ts' ? { ...file, content: 'x'.repeat(file.bytes) } : file) } }]) {
      db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify({ ...config, agent: { ...config.agent, extensions: corrupt } }), accepted.runId!);
      expect(() => repos.readRunExtensions(accepted.runId!)).toThrow();
    }
    delete config.agent.extensions; db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify(config), accepted.runId!);
    expect(repos.readRunExtensions(accepted.runId!)).toBeNull(); expect(db.query<{version:number},[]>('SELECT max(version) AS version FROM schema_migrations').get()?.version).toBe(12);
  } finally { db.close(); rmSync(root, {recursive:true,force:true}); }
});

test('p12 invalid frozen evidence rolls back input acceptance and bounded source cannot be silently truncated', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-rollback-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const frozen = frozenExtension();
    for (const value of [{ ...frozen, sessionId: 2 }, { ...frozen, configVersion: '2' }, { ...frozen, selection: { extension: ref } }]) {
      expect(() => acceptContextInput(db, { extensions: value })).toThrow();
      expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);
      expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM session_inputs').get()?.n).toBe(0);
    }
    expect(FrozenRunExtensionsSchema.safeParse({ ...frozen, source: null }).success).toBe(false);
    expect(FrozenRunExtensionsSchema.safeParse({ ...frozen, source: { ...frozen.source!, files: [frozen.source!.files[0], frozen.source!.files[0]] } }).success).toBe(false);
    const oversized = 'x'.repeat(65537);
    expect(FrozenRunExtensionsSchema.safeParse({ ...frozen, source: { ...frozen.source!, files: [frozen.source!.files[0], { ...frozen.source!.files[1], content: oversized, bytes: oversized.length }] } }).success).toBe(false);
  } finally { db.close(); rmSync(root, {recursive:true,force:true}); }
});

test('p12 cleanup retains original assembly and budget and rejects release or diagnostic regression', () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-cleanup-')), db = openDatabase(join(root, 'app.sqlite'));
  try {
    const frozen = frozenExtension(), { repos, accepted } = acceptContextInput(db, { extensions: frozen }), runId = accepted.runId!;
    const at = '2026-10-06T00:00:00.000Z', error = safeError('extension_cleanup_failed', undefined, {runId,sessionId:1});
    const proof: ExtensionAssemblyProof = { instanceId: 'host', sessionId: 1, runId, assemblyId: 'a', contract: 'medclaw.extension-assembly/v1', ref: frozen.selection.extension!,
      state: 'active', loadedAt: at, disposedAt: null, callableTools: ['extension_runtime_status'], callableCommands: ['extension_status'],
      hookCounts: { input: 1, context: 1, tool_call: 1, tool_result: 1 }, resourcesReleased: false, diagnostics: [error] };
    const cleanup: RunCleanupRecord = { contract: 'medclaw.run-cleanup/v1', executionStarted: true, stopConfirmed: true, requiredPersistenceComplete: false,
      inputsSettled: false, resourcesReleased: false, unconfirmedItems: ['extension_cleanup'], secondaryErrors: [error], verifiedAt: at, extensions: proof,
      budgetSummary: {version:'medclaw.budget-summary/v1',toolCalls:1,modelCalls:1,toolAdmissionsRejected:0,modelAdmissionsRejected:0,convergenceRequested:false,recoveryAttempts:0,stopReason:null,unresolvedItems:[]} };
    for (const patch of [{ instanceId: 'other' }, { sessionId: 2 }, { runId: runId + 1 }, { ref }]) expect(() => repos.saveRunCleanup(runId, { ...cleanup, extensions: { ...proof, ...patch } })).toThrow();
    expect(() => repos.saveRunCleanup(runId, { ...cleanup, resourcesReleased: true })).toThrow();
    expect(() => repos.saveRunCleanup(runId,{...cleanup,extensionReleaseBasis:'not_loaded'})).toThrow();
    repos.saveRunCleanup(runId, cleanup);
    expect(() => repos.saveRunCleanup(runId, { ...cleanup, secondaryErrors: [] })).toThrow();
    const disposed = { ...proof, state: 'disposed' as const, resourcesReleased: true, disposedAt: at };
    const complete: RunCleanupRecord = { ...cleanup, resourcesReleased: true, extensions: disposed, unconfirmedItems: [] }; delete complete.budgetSummary;
    repos.saveRunCleanup(runId, complete);
    const read = repos.read({runId}); if (read.kind !== 'one' || !read.run?.cleanup) throw new Error('Original run cleanup missing');
    const saved = read.run.cleanup;
    expect(saved.extensions).toEqual(disposed); expect(saved.budgetSummary).toEqual(cleanup.budgetSummary);
    expect(() => repos.saveRunCleanup(runId, cleanup)).toThrow();
    expect(() => repos.saveRunCleanup(runId, {...complete, extensions: {...disposed, assemblyId:'other'}})).toThrow();
    const compatible = {...complete}; delete compatible.extensions;
    repos.saveRunCleanup(runId, compatible);
    const again = repos.read({runId}); if (again.kind !== 'one' || !again.run?.cleanup) throw new Error('Original cleanup missing');
    expect(again.run.cleanup.extensions).toEqual(disposed);
  } finally { db.close(); rmSync(root, {recursive:true,force:true}); }
});

test('p12 no-assembly release requires a valid monotonic basis and never fabricates an instance',()=>{
  const root=mkdtempSync(join(tmpdir(),'medclaw-p12-no-assembly-')),db=openDatabase(join(root,'app.sqlite'));
  try {
    const {repos,accepted}=acceptContextInput(db,{extensions:frozenExtension(),consume:false}),runId=accepted.runId!;
    const cleanup:RunCleanupRecord={contract:'medclaw.run-cleanup/v1',executionStarted:false,stopConfirmed:true,requiredPersistenceComplete:false,inputsSettled:false,resourcesReleased:true,unconfirmedItems:['persistence','inputs'],secondaryErrors:[],verifiedAt:null};
    expect(()=>repos.saveRunCleanup(runId,cleanup)).toThrow();
    expect(()=>repos.saveRunCleanup(runId,{...cleanup,executionStarted:true,extensionReleaseBasis:'not_loaded'})).toThrow();
    repos.saveRunCleanup(runId,{...cleanup,extensionReleaseBasis:'not_loaded'});
    repos.saveRunCleanup(runId,cleanup);
    expect(repos.read({runId})).toMatchObject({kind:'one',run:{cleanup:{extensionReleaseBasis:'not_loaded',resourcesReleased:true}}});
    expect(()=>repos.saveRunCleanup(runId,{...cleanup,extensionReleaseBasis:'owner_process_exited'})).toThrow();
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('p12 static source freezing and managed copies do not evaluate the module and reject changed author bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-author-')), workdir = mkdtempSync(join(tmpdir(), 'medclaw-p12-copy-'));
  try {
    const frozen = frozenExtension(), version = join(root, 'tool-audit', 'v1'); mkdirSync(version, {recursive:true});
    for (const file of frozen.source!.files) writeFileSync(join(version,file.file), file.content);
    const loader = await import('../../packages/runtime-pi/src/extension-loader').catch(() => null);
    expect(loader?.readExtensionDescriptor).toBeFunction();
    const descriptor = await loader!.readExtensionDescriptor(root); expect(descriptor.ref).toEqual(frozen.selection.extension!);
    expect(await loader!.freezeRunExtensions(root,1,{...PublishedSettingsSchema.parse(settings),extensions:{bySession:{'1':frozen.selection}}})).toEqual(frozen);
    const off = await loader!.freezeRunExtensions(root,1,PublishedSettingsSchema.parse(settings)); expect(off.selection.extension).toBeNull(); expect(off.source).toBeNull();
    expect(await loader!.materializeRunExtension(workdir,off)).toBeNull();
    const entry = await loader!.materializeRunExtension(workdir,frozen); expect(entry).toBe(join(workdir,'extensions','tool-audit','v1',descriptor.ref.treeHash,'index.ts'));
    writeFileSync(join(version,'index.ts'),'CHANGED');
    await expect(loader!.freezeRunExtensions(root,1,{...PublishedSettingsSchema.parse(settings),extensions:{bySession:{'1':frozen.selection}}})).rejects.toMatchObject({code:'extension_unavailable'});
    expect(await loader!.materializeRunExtension(workdir,frozen)).toBe(entry);
    writeFileSync(entry!,'TAMPERED'); await expect(loader!.materializeRunExtension(workdir,frozen)).rejects.toMatchObject({code:'extension_unavailable'});
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(workdir,{recursive:true,force:true}); }
});

test('p12 fixed author and materialization reject symlinks, undeclared files and malformed manifests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p12-invalid-')), outside = mkdtempSync(join(tmpdir(),'medclaw-p12-outside-'));
  try {
    const frozen = frozenExtension(), version = join(root,'tool-audit','v1'); mkdirSync(version,{recursive:true});
    const loader = await import('../../packages/runtime-pi/src/extension-loader').catch(() => null); expect(loader?.readExtensionDescriptor).toBeFunction();
    for (const file of frozen.source!.files) writeFileSync(join(version,file.file),file.content);
    writeFileSync(join(version,'extra.ts'),'EXTRA'); await expect(loader!.readExtensionDescriptor(root)).rejects.toMatchObject({code:'extension_unavailable'});
    rmSync(join(version,'extra.ts')); writeFileSync(join(version,'manifest.json'),'{}'); await expect(loader!.readExtensionDescriptor(root)).rejects.toMatchObject({code:'extension_unavailable'});
    rmSync(version,{recursive:true}); symlinkSync(outside,version,process.platform==='win32'?'junction':'dir'); await expect(loader!.readExtensionDescriptor(root)).rejects.toMatchObject({code:'extension_unavailable'});
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
});
