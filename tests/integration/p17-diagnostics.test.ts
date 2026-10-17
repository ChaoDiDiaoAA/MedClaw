import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DestinationTokens } from '../../apps/desktop/src/main/destination-tokens';
import { FileTokens } from '../../apps/desktop/src/main/file-tokens';
import { DiagnosticsViewSchema, HOST_PROTOCOL_VERSION, type DiagnosticsView } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'MedClaw 支持包-'))), data = join(root, 'data'), destination = join(root, 'external');
  mkdirSync(data); mkdirSync(destination);
  const tokens = new FileTokens(), operationRef = crypto.randomUUID(), grant = tokens.issueMaintenance(1, operationRef, 'support-destination', destination);
  const authorize = () => { expect(tokens.resolveMaintenance(grant.fileToken, 1, operationRef, 'support-destination')).toBe(destination); };
  const view: DiagnosticsView = { partial: true, missingSources: ['host'], versions: { sdkVersion: '0.87.1', protocolVersion: HOST_PROTOCOL_VERSION, schemaVersion: null, configVersion: '1', bunVersion: null, electronVersion: '44.5.1' },
    host: { instanceId: 'ended-host', state: 'failed', canStart: true, sdkVersion: '0.87.1', schemaVersion: null, error: { ...safeError('host_start_failed'), message: 'PRIVATE provider body' } },
    dependencies: [{ name: 'bash', path: 'C:\\Users\\PRIVATE_PERSON\\bin\\bash.exe', version: '5.2', source: 'sdk_standard_discovery' }],
    entries: [{ at: '2026-10-17T00:00:00.000Z', source: 'main', category: 'runtime', message: 'Host ready inputChars=12 outputChars=34' },
      { at: '2026-10-17T00:00:00.000Z', source: 'host', category: 'errors', message: 'PRIVATE provider body', error: { ...safeError('model_request_failed'), message: 'PRIVATE bearer credential' } },
      { at: '2026-10-17T00:00:00.000Z', source: 'host', category: 'prompt_trace', message: 'PRIVATE prompt and Gold' }],
  };
  const input = { operationRef, categories: ['versions', 'host', 'errors', 'runtime'] as Array<'versions' | 'host' | 'errors' | 'runtime' | 'prompt_trace'> };
  return { root, data, destination, tokens, authorize, view, input, destinations: new DestinationTokens(data), close() {
    const target = realpathSync(root), part = relative(realpathSync(tmpdir()), target);
    if (target !== root || !part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('ENGINEERING support root retained: ' + root);
    rmSync(target, { recursive: true, force: true });
  } };
}

test('support export is partial without Host, removes private text and paths, and returns the original published receipt', async () => {
  const f = fixture(); let reads = 0;
  try {
    expect(f.destinations.exportSupport).toBeFunction();
    const result = await f.destinations.exportSupport(f.destination, f.input, async () => { reads++; return f.view; }, f.authorize);
    const path = join(f.destination, 'MedClaw-support-'+f.input.operationRef+'.json'), text = readFileSync(path, 'utf8'), record = JSON.parse(text);
    expect(result).toMatchObject({ operationRef: f.input.operationRef, state: 'completed', partial: true, bytes: Buffer.byteLength(text) });
    expect(text).not.toContain('PRIVATE'); expect(text).not.toContain('C:\\Users');
    expect(record.diagnostics.dependencies).toEqual([{ name: 'bash', program: 'bash.exe', version: '5.2', source: 'sdk_standard_discovery' }]);
    expect(record.diagnostics.entries).toHaveLength(2); expect(record.diagnostics.entries[0].message).toBe('Host ready inputChars=12 outputChars=34');
    expect(record.diagnostics.host).not.toHaveProperty('shutdown');
    expect(await f.destinations.exportSupport(f.destination, f.input, async () => { throw new Error('Do not collect again'); }, f.authorize)).toEqual(result);
    expect(await f.destinations.readSupport(f.destination, f.input)).toEqual(result);
    const inspected = await f.destinations.inspectSupportFile(path);
    expect(inspected.operationRef).toBe(f.input.operationRef); expect(inspected.categories).toEqual(expect.arrayContaining(f.input.categories)); expect(inspected.categories).toHaveLength(f.input.categories.length);
    expect(await f.destinations.exportSupport(f.destination, { ...f.input, categories: [...f.input.categories].reverse() }, async () => { throw new Error('No replay'); }, f.authorize)).toEqual(result);
    expect(reads).toBe(1); expect(readdirSync(f.destination)).toEqual(['MedClaw-support-'+f.input.operationRef+'.json']); expect(readdirSync(f.data)).toEqual([]);
    await expect(f.destinations.exportSupport(f.destination, { ...f.input, categories: ['runtime'] }, async () => f.view, f.authorize)).rejects.toThrow('state_conflict');
    expect(readFileSync(path, 'utf8')).toBe(text);
  } finally { f.close(); }
}, 30000);

test('support originals at 8 MiB remain readable while an extra byte is rejected before opening or recollecting', async () => {
  const f = fixture(); let opening: ReturnType<typeof spyOn> | undefined;
  try {
    const receipt = await f.destinations.exportSupport(f.destination, f.input, async () => f.view, f.authorize);
    const path = join(f.destination, 'MedClaw-support-' + f.input.operationRef + '.json'), original = readFileSync(path);
    const boundary = Buffer.concat([original, Buffer.alloc(8388608 - original.length, 32)]); writeFileSync(path, boundary);
    const fs = await import('node:fs/promises'), native = fs.open; let opened = 0, collected = 0;
    opening = spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof native>) => { if (String(args[0]) === path) opened++; return native(...args); });
    expect(await f.destinations.readSupport(f.destination, f.input)).toEqual({ ...receipt, bytes: 8388608 }); expect(opened).toBe(1);
    expect(await f.destinations.inspectSupportFile(path)).toMatchObject({ operationRef: f.input.operationRef }); expect(opened).toBe(2);
    const oversized = Buffer.concat([boundary, Buffer.from(' ')]); writeFileSync(path, oversized); opened = 0;
    await expect(f.destinations.readSupport(f.destination, f.input)).rejects.toThrow('diagnostics_bundle_invalid');
    await expect(f.destinations.inspectSupportFile(path)).rejects.toThrow('diagnostics_bundle_invalid');
    await expect(f.destinations.exportSupport(f.destination, f.input, async () => { collected++; return f.view; }, f.authorize)).rejects.toThrow('diagnostics_bundle_invalid');
    expect(opened).toBe(0); expect(collected).toBe(0); expect(readFileSync(path).equals(oversized)).toBe(true);
    opening.mockRestore(); opening = undefined; writeFileSync(path, original);
    expect(await f.destinations.readSupport(f.destination, f.input)).toEqual(receipt);
    expect(readdirSync(f.destination)).toEqual(['MedClaw-support-' + f.input.operationRef + '.json']); expect(readdirSync(f.data)).toEqual([]);
  } finally { opening?.mockRestore(); f.close(); }
}, 30000);

test('an authorized oversized support snapshot fails before file creation and preserves the earlier bundle', async () => {
  const f = fixture(); let opening: ReturnType<typeof spyOn> | undefined;
  try {
    const receipt = await f.destinations.exportSupport(f.destination, f.input, async () => f.view, f.authorize);
    const originalPath = join(f.destination, 'MedClaw-support-' + f.input.operationRef + '.json'), original = readFileSync(originalPath);
    const next = { ...f.input, operationRef: crypto.randomUUID() }, grant = f.tokens.issueMaintenance(1, next.operationRef, 'support-destination', f.destination);
    const authorize = () => { f.tokens.resolveMaintenance(grant.fileToken, 1, next.operationRef, 'support-destination'); };
    const error = safeError('event_gap', undefined, { operationRef: 'x'.repeat(256), runId: 9007199254740991, sessionId: 9007199254740991, reason: 'session_metadata_revision_mismatch' });
    const snapshot: DiagnosticsView = { ...f.view, entries: Array.from({ length: 8300 }, () => ({ category: 'errors', source: 'host',
      at: '2026-10-17T00:00:00.000Z', operationRef: 'y'.repeat(256), runId: 9007199254740991, message: 'ENGINEERING private body', error })) };
    expect(DiagnosticsViewSchema.parse(snapshot).entries).toHaveLength(8300);
    const fs = await import('node:fs/promises'), native = fs.open; let opened = 0, collected = 0;
    opening = spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof native>) => { opened++; return native(...args); });
    await expect(f.destinations.exportSupport(f.destination, next, async () => { collected++; return snapshot; }, authorize)).rejects.toThrow('diagnostics_export_failed');
    expect(collected).toBe(1); expect(opened).toBe(0); opening.mockRestore(); opening = undefined;
    expect(readFileSync(originalPath).equals(original)).toBe(true); expect(await f.destinations.readSupport(f.destination, f.input)).toEqual(receipt);
    expect(await f.destinations.readSupport(f.destination, next)).toBeNull();
    expect(readdirSync(f.destination)).toEqual(['MedClaw-support-' + f.input.operationRef + '.json']); expect(readdirSync(f.data)).toEqual([]);
  } finally { opening?.mockRestore(); f.close(); }
}, 30000);

test('support keeps unknown shutdown fields null and removes unsafe stage suffixes and opted-in private trace text', async () => {
  const f = fixture();
  try {
    f.input.categories.push('prompt_trace'); f.view.host.state = 'stopping'; f.view.host.canStart = false;
    f.view.host.shutdown = { executionStopped: null, requiredPersistenceComplete: null, databaseClosed: null, processExited: false,
      processTreeStopped: null, error: { ...safeError('host_stop_unconfirmed'), message: 'PRIVATE native stop details' } };
    for (const message of ['Host ready inputChars=12 outputChars=34 PRIVATE suffix',
      JSON.stringify({ kind: 'private', secret: true, credential: 'PRIVATE key', provider: 'PRIVATE body' }), 'PRIVATE Query rows and Gold']) {
      f.view.entries.push({ category: 'prompt_trace', source: 'host', at: '2026-10-17T00:00:00.000Z', message });
    }
    const receipt = await f.destinations.exportSupport(f.destination, f.input, async () => f.view, f.authorize);
    const text = readFileSync(join(f.destination, 'MedClaw-support-' + f.input.operationRef + '.json'), 'utf8'), record = JSON.parse(text);
    expect(receipt.partial).toBe(true); expect(record.diagnostics).toMatchObject({ partial: true, missingSources: ['host'], host: { state: 'stopping', canStart: false,
      shutdown: { executionStopped: null, requiredPersistenceComplete: null, databaseClosed: null, processExited: false, processTreeStopped: null, error: { code: 'host_stop_unconfirmed' } } } });
    expect(text).not.toContain('PRIVATE'); expect(text).not.toContain('"secret"'); expect(text).not.toContain('"credential"');
    expect(record.diagnostics.entries[0].message).toBe('Host ready inputChars=12 outputChars=34');
    expect(record.diagnostics.entries.slice(3).map((entry: { message: string }) => entry.message)).toEqual(['Diagnostic content omitted', 'Diagnostic content omitted', 'Diagnostic content omitted']);
    expect(record.request.categories).toContain('prompt_trace'); expect(await f.destinations.readSupport(f.destination, f.input)).toEqual(receipt);
  } finally { f.close(); }
}, 30000);

test('raw stderr provider credential private-frame and business fields cannot enter a support DTO or overwrite the original', async () => {
  const f = fixture();
  try {
    const receipt = await f.destinations.exportSupport(f.destination, f.input, async () => f.view, f.authorize);
    const path = join(f.destination, 'MedClaw-support-' + f.input.operationRef + '.json'), original = readFileSync(path);
    for (const field of ['stderr', 'provider', 'credentials', 'privateFrame', 'businessText']) {
      const next = { ...f.input, operationRef: crypto.randomUUID() }, grant = f.tokens.issueMaintenance(1, next.operationRef, 'support-destination', f.destination);
      const authorize = () => { f.tokens.resolveMaintenance(grant.fileToken, 1, next.operationRef, 'support-destination'); };
      await expect(f.destinations.exportSupport(f.destination, next, async () => ({ ...f.view, [field]: 'PRIVATE raw content' }), authorize)).rejects.toThrow('diagnostics_export_failed');
      expect(await f.destinations.readSupport(f.destination, next)).toBeNull(); expect(readFileSync(path).equals(original)).toBe(true);
    }
    expect(await f.destinations.readSupport(f.destination, f.input)).toEqual(receipt);
    expect(readdirSync(f.destination)).toEqual(['MedClaw-support-' + f.input.operationRef + '.json']); expect(readdirSync(f.data)).toEqual([]);
  } finally { f.close(); }
}, 30000);

test('support authorization is rechecked after collection and never publishes after the window closes', async () => {
  const f = fixture();
  try {
    await expect(f.destinations.exportSupport(f.destination, f.input, async () => { f.tokens.closeWindow(1); return f.view; }, f.authorize)).rejects.toThrow('access_denied');
    expect(readdirSync(f.destination)).toEqual([]);
    expect(await f.destinations.readSupport(f.destination, f.input)).toBeNull();
  } finally { f.close(); }
}, 30000);

test('a support disk failure preserves the earlier complete bundle and reports its own operation', async () => {
  const f = fixture(); let failure: ReturnType<typeof spyOn> | undefined;
  try {
    const original = await f.destinations.exportSupport(f.destination, f.input, async () => f.view, f.authorize);
    const fs = await import('node:fs/promises'), native = fs.open, next = { ...f.input, operationRef: crypto.randomUUID() };
    failure = spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof native>) => {
      if (String(args[0]).includes('.MedClaw-support-'+next.operationRef)) throw Object.assign(new Error('PRIVATE disk information'), { code: 'ENOSPC' });
      return native(...args);
    });
    await expect(f.destinations.exportSupport(f.destination, next, async () => f.view, () => {})).rejects.toThrow('diagnostics_export_failed');
    failure.mockRestore(); failure = undefined;
    expect(await f.destinations.readSupport(f.destination, f.input)).toEqual(original);
    expect(await f.destinations.readSupport(f.destination, next)).toBeNull();
    expect(readdirSync(f.destination)).toEqual(['MedClaw-support-'+f.input.operationRef+'.json']);
  } finally { failure?.mockRestore(); f.close(); }
}, 30000);

test('invalid original support files and business-root destinations cannot authorize a new publication', async () => {
  const f = fixture();
  try {
    await expect(f.destinations.exportSupport(f.data, f.input, async () => f.view, () => {})).rejects.toThrow('access_denied');
    const result = await f.destinations.exportSupport(f.destination, f.input, async () => f.view, f.authorize);
    const path = join(f.destination, 'MedClaw-support-'+result.operationRef+'.json'), renamed = join(f.destination, 'other.json');
    copyFileSync(path, renamed); await expect(f.destinations.inspectSupportFile(renamed)).rejects.toThrow('diagnostics_bundle_invalid');
    const changed = JSON.parse(readFileSync(path, 'utf8')); changed.receipt.operationRef = 'different-original';
    const content = JSON.stringify(changed); writeFileSync(path, content);
    await expect(f.destinations.readSupport(f.destination, f.input)).rejects.toThrow('diagnostics_bundle_invalid');
    await expect(f.destinations.exportSupport(f.destination, f.input, async () => { throw new Error('No replay'); }, f.authorize)).rejects.toThrow('diagnostics_bundle_invalid');
    expect(readFileSync(path, 'utf8')).toBe(content); expect(readdirSync(f.data)).toEqual([]);
  } finally { f.close(); }
}, 30000);
