import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { OpaqueIdSchema } from '../../../../packages/contracts/src/error';
import { canonicalRequest } from '../../../../packages/contracts/src/run';
import { DesktopExportDestinationSchema, ExportCopyReceiptSchema, ExportDestinationCopySchema, ExportDestinationSchema, ExportManifestSchema,
  type ExportCopyReceipt, type ExportCopyVerification, type ExportManifest } from '../../../../packages/contracts/src/export';
import { pinDirectory, publishNoReplace } from '../../../../packages/storage/src/publish-no-replace';

type Source = z.infer<typeof DesktopExportDestinationSchema>;
type Copy = z.infer<typeof ExportDestinationCopySchema>;
type Grant = Source & { windowId: number; instanceId: string; target: string; parent: string; parentIdentity: string; expires: number };
type Copying = { windowId: number; instanceId: string; key: string; controller: AbortController; promise: Promise<ExportCopyReceipt> };
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const ProofSchema = z.strictObject({ receipt: ExportCopyReceiptSchema, manifest: ExportManifestSchema, parentIdentity: z.string().min(1), targetName: z.string().min(1) });

export class DestinationTokens {
  private readonly tokens = new Map<string, Grant>();
  private readonly active = new Map<string, Copying>();
  constructor(private readonly dataRoot: string, private readonly clock = Date.now,
    private readonly verifyCopy?: (instanceId: string, input: ExportCopyVerification) => Promise<void>) {}
  private directory(path: string) {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, component); const stat = lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('export_destination_invalid');
    }
    if (!samePath(realpathSync(absolute), absolute)) throw new Error('export_destination_invalid');
    return { path: realpathSync(absolute), identity: identity(lstatSync(absolute, { bigint: true })) };
  }
  issue(windowId: number, instanceId: string, value: Source, targetPath: string) {
    const source = DesktopExportDestinationSchema.parse(value); OpaqueIdSchema.parse(instanceId);
    if (!Number.isSafeInteger(windowId) || windowId <= 0 || !isAbsolute(targetPath)) throw new Error('export_destination_invalid');
    try {
      const name = basename(targetPath);
      if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('export_destination_invalid');
      const parent = this.directory(dirname(targetPath)), root = this.directory(this.dataRoot), target = join(parent.path, name), within = relative(root.path, target);
      if (!within || !within.startsWith('..' + sep) && within !== '..' && !isAbsolute(within)) throw new Error('export_destination_invalid');
      this.checkTarget(target);
      const destinationToken = randomUUID();
      for (const [token, grant] of this.tokens) if (grant.expires <= this.clock()) this.tokens.delete(token);
      this.tokens.set(destinationToken, { ...source, windowId, instanceId, parent: parent.path, parentIdentity: parent.identity, target, expires: this.clock() + 15 * 60 * 1000 });
      return { destinationToken, displayName: name };
    } catch { throw new Error('export_destination_invalid'); }
  }
  private checkTarget(path: string) {
    try { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('export_destination_invalid'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private grant(windowId: number, instanceId: string, input: z.infer<typeof ExportDestinationSchema>) {
    const grant = this.tokens.get(input.destinationToken);
    if (!grant || grant.windowId !== windowId || grant.instanceId !== instanceId || grant.expires <= this.clock()
      || grant.operationRef !== input.operationRef || grant.queryId !== input.queryId || grant.answerId !== input.answerId
      || grant.format !== input.format) throw new Error('export_destination_invalid');
    this.checkParent(grant); return grant;
  }
  private checkParent(grant: Grant) {
    try {
      const parent = this.directory(grant.parent);
      if (parent.identity !== grant.parentIdentity || !samePath(parent.path, grant.parent)) throw new Error('export_destination_invalid');
      this.checkTarget(grant.target);
    } catch { throw new Error('export_destination_invalid'); }
  }
  async describe(windowId: number, instanceId: string, value: z.infer<typeof ExportDestinationSchema>) {
    const input = ExportDestinationSchema.parse(value); this.grant(windowId, instanceId, input);
    return { valid: true as const };
  }
  async copy(windowId: number, instanceId: string, value: Copy): Promise<ExportCopyReceipt> {
    const input = ExportDestinationCopySchema.parse(value);
    if (!this.verifyCopy) throw new Error('export_copy_failed');
    const grant = this.grant(windowId, instanceId, input), key = canonicalRequest({ ...input, destinationToken: null }), old = this.active.get(input.operationRef);
    if (old) { if (old.windowId !== windowId || old.instanceId !== instanceId || old.key !== key) throw new Error('state_conflict'); return old.promise; }
    const controller = new AbortController(), active: Copying = { windowId, instanceId, key, controller, promise: Promise.resolve(null as never) };
    active.promise = this.deliver(grant, input, controller.signal);
    this.active.set(input.operationRef, active);
    try { return await active.promise; } finally { if (this.active.get(input.operationRef) === active) this.active.delete(input.operationRef); }
  }
  private async file(path: string, expected: { bytes: number }, signal?: AbortSignal, original?: string) {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !samePath(await realpath(path), path) || before.size !== BigInt(expected.bytes)) throw new Error('artifact_not_ready');
    const file = await open(path, 'r');
    let other: Awaited<ReturnType<typeof open>> | null = null;
    try {
      if (identity(await file.stat({ bigint: true })) !== identity(before)) throw new Error('artifact_not_ready');
      const sourceBefore = original ? await lstat(original, { bigint: true }) : null;
      if (original && sourceBefore) {
        if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink() || !samePath(await realpath(original), original) || sourceBefore.size !== before.size) throw new Error('artifact_not_ready');
        other = await open(original, 'r');
        if (identity(await other.stat({ bigint: true })) !== identity(sourceBefore)) throw new Error('artifact_not_ready');
      }
      const buffer = Buffer.alloc(256 * 1024), comparison = other ? Buffer.alloc(buffer.length) : null;
      let position = 0;
      while (position < expected.bytes) {
        signal?.throwIfAborted(); const count = Math.min(buffer.length, expected.bytes - position);
        const read = await file.read(buffer, 0, count, position);
        if (read.bytesRead !== count) throw new Error('artifact_not_ready');
        if (other && comparison) {
          const compared = await other.read(comparison, 0, count, position);
          if (compared.bytesRead !== count || !buffer.subarray(0, count).equals(comparison.subarray(0, count))) throw new Error('artifact_not_ready');
        }
        position += count;
      }
      const after = await file.stat({ bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || identity(await lstat(path, { bigint: true })) !== identity(before)) throw new Error('artifact_not_ready');
      if (other && original && sourceBefore) {
        const sourceAfter = await other.stat({ bigint: true });
        if (sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeNs !== sourceBefore.mtimeNs || identity(await lstat(original, { bigint: true })) !== identity(sourceBefore)) throw new Error('artifact_not_ready');
      }
    } finally { await Promise.allSettled([file.close(), other?.close()]); }
  }
  private async source(input: Copy) {
    const root = this.directory(this.dataRoot), artifacts = this.directory(join(root.path, 'artifacts')), directory = this.directory(join(artifacts.path, String(input.artifactId)));
    const manifestPath = join(directory.path, 'manifest.json'), stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('artifact_not_ready');
    const manifest = ExportManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    if (canonicalRequest(manifest) !== canonicalRequest(input.manifest)
      || canonicalRequest((await readdir(directory.path)).sort()) !== canonicalRequest([...manifest.files.map(file => file.path), 'manifest.json'].sort())) throw new Error('artifact_not_ready');
    for (const file of manifest.files) await this.file(join(directory.path, file.path), file);
    return { directory, manifest };
  }
  private async proof(exportId: number, operationRef: string, scan = true) {
    const root = this.directory(join(this.dataRoot, 'runtime/export-copies'));
    const read = async (name: string) => {
      const path = join(root.path, name), before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size > 131072n) throw new Error('export_copy_failed');
      const file = await open(path, 'r');
      try {
        if (identity(await file.stat({ bigint: true })) !== identity(before)) throw new Error('export_copy_failed');
        const value: unknown = JSON.parse(await file.readFile('utf8')), after = await file.stat({ bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || identity(await lstat(path, { bigint: true })) !== identity(before)) throw new Error('export_copy_failed');
        return value;
      } finally { await file.close(); }
    };
    const checked = (value: unknown) => {
      const parsed = ProofSchema.safeParse(value);
      if (!parsed.success || parsed.data.receipt.operationRef !== operationRef) throw new Error('state_conflict');
      return parsed.data;
    };
    const name = String(exportId) + '.json';
    try { return checked(await read(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !scan) throw error; }
    const names = (await readdir(root.path)).filter(value => value.endsWith('.json') && value !== name);
    // shortcut: Legacy operation lookup reads at most 1000 receipts; use a known Export ID for larger archives.
    for (const candidate of names.slice(0, 1000)) {
      const value = await read(candidate);
      const owner = z.object({ receipt: z.object({ operationRef: z.string() }) }).safeParse(value);
      if (owner.success && owner.data.receipt.operationRef === operationRef) return checked(value);
    }
    if (names.length > 1000) throw new Error('state_conflict');
    throw Object.assign(new Error('export_copy_failed'), { code: 'ENOENT' });
  }
  private async external(grant: Grant, manifest: ExportManifest, source: string) {
    this.checkParent(grant);
    if (manifest.format === 'csv') {
      const directory = this.directory(grant.target);
      if (canonicalRequest((await readdir(directory.path)).sort()) !== canonicalRequest(manifest.files.map(file => file.path).sort())) throw new Error('destination_conflict');
    }
    for (const file of manifest.files) await this.file(manifest.format === 'csv' ? join(grant.target, file.path) : grant.target, file, undefined, join(source, file.path));
    this.checkParent(grant);
  }
  private async verifyCopied(grant: Grant, input: Copy, path: string, manifest: ExportManifest, signal: AbortSignal) {
    if (!this.verifyCopy) throw new Error('export_copy_failed');
    const directoryIdentity = manifest.format === 'csv' ? this.directory(path).identity : null;
    const files = await Promise.all(manifest.files.map(async file => {
      const name = manifest.format === 'csv' ? join(path, file.path) : path, stat = await lstat(name, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(file.bytes) || !samePath(await realpath(name), name)) throw new Error('artifact_not_ready');
      return { name, stat };
    }));
    // The Host compares the candidate with saved Query facts, so a restored source cannot endorse a bad copy.
    await this.verifyCopy(grant.instanceId, { operationRef: input.operationRef, exportId: input.exportId, artifactId: input.artifactId, temporaryPath: path });
    signal.throwIfAborted(); this.grant(grant.windowId, grant.instanceId, input);
    if (directoryIdentity !== null && this.directory(path).identity !== directoryIdentity) throw new Error('artifact_not_ready');
    for (const file of files) {
      const current = await lstat(file.name, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || identity(current) !== identity(file.stat)
        || current.size !== file.stat.size || current.mtimeNs !== file.stat.mtimeNs || !samePath(await realpath(file.name), file.name)) throw new Error('artifact_not_ready');
    }
  }
  private async copyFile(source: string, target: string, signal: AbortSignal, created: (identity: string) => void) {
    const sourceStat = await lstat(source, { bigint: true });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('artifact_not_ready');
    const input = await open(source, 'r'); let output: Awaited<ReturnType<typeof open>> | null = null;
    try {
      output = await open(target, 'wx'); created(identity(await output.stat({ bigint: true })));
      if (identity(await input.stat({ bigint: true })) !== identity(sourceStat)) throw new Error('artifact_not_ready');
      const buffer = Buffer.alloc(256 * 1024);
      while (true) {
        signal.throwIfAborted(); const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        let offset = 0; while (offset < bytesRead) { signal.throwIfAborted(); const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null); if (!bytesWritten) throw new Error('export_copy_failed'); offset += bytesWritten; }
      }
      await output.sync();
      const after = await input.stat({ bigint: true });
      if (after.size !== sourceStat.size || after.mtimeNs !== sourceStat.mtimeNs || identity(await lstat(source, { bigint: true })) !== identity(sourceStat)) throw new Error('artifact_not_ready');
    } finally { await Promise.allSettled([input.close(), output?.close()]); }
  }
  private async saveProof(receipt: ExportCopyReceipt, manifest: ExportManifest, grant: Grant) {
    const runtime = join(this.directory(this.dataRoot).path, 'runtime'); await mkdir(runtime, { recursive: true }); this.directory(runtime);
    const directory = join(runtime, 'export-copies'); await mkdir(directory, { recursive: true }); const root = this.directory(directory);
    const target = join(root.path, String(receipt.exportId) + '.json'), content = canonicalRequest({ receipt, manifest, parentIdentity: grant.parentIdentity, targetName: basename(grant.target).toLowerCase() });
    try { const old = await this.proof(receipt.exportId, receipt.operationRef, false); if (canonicalRequest(old) !== content) throw new Error('state_conflict'); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = join(root.path, '.' + receipt.exportId + '.' + randomUUID() + '.tmp');
    await writeFile(temporary, content, { flag: 'wx' });
    try { if (this.directory(root.path).identity !== root.identity) throw new Error('export_copy_failed'); await publishNoReplace(temporary, target, 'file'); }
    finally { try { if (this.directory(root.path).identity === root.identity) await unlink(temporary); } catch {} }
  }
  private async deliver(grant: Grant, input: Copy, signal: AbortSignal): Promise<ExportCopyReceipt> {
    const release = await pinDirectory(grant.parent, signal);
    try { this.checkParent(grant); return await this.deliverPinned(grant, input, signal); }
    finally { await release(); }
  }
  private async deliverPinned(grant: Grant, input: Copy, signal: AbortSignal): Promise<ExportCopyReceipt> {
    const { directory, manifest } = await this.source(input);
    this.checkParent(grant); signal.throwIfAborted();
    let present = false;
    try { await lstat(grant.target); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (present) {
      let proven: ExportCopyReceipt | null = null;
      for (const operationRef of [input.operationRef, ...input.priorOperationRefs]) {
        try {
          const proof = await this.proof(input.exportId, operationRef);
          if (proof.receipt.operationRef === operationRef && proof.parentIdentity === grant.parentIdentity && proof.targetName === basename(grant.target).toLowerCase()
            && proof.receipt.artifactId === input.artifactId && canonicalRequest(proof.manifest) === canonicalRequest(manifest)) { proven = proof.receipt; break; }
        } catch (error) { if (error instanceof Error && error.message === 'state_conflict') throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('destination_conflict'); }
      }
      if (!proven) throw new Error('destination_conflict');
      await this.external(grant, manifest, directory.path);
      await this.verifyCopied(grant, input, grant.target, manifest, signal);
      if (proven.operationRef === input.operationRef) { if (proven.exportId !== input.exportId) throw new Error('state_conflict'); return proven; }
    } else {
      const temporary = join(grant.parent, '.' + input.exportId + '.' + randomUUID() + '.tmp');
      let owned: string | null = null, published = false, releaseTemporary: (() => Promise<void>) | null = null;
      try {
        if (manifest.format === 'csv') { await mkdir(temporary); owned = identity(await lstat(temporary, { bigint: true })); releaseTemporary = await pinDirectory(temporary, signal); if (owned !== this.directory(temporary).identity) throw new Error('export_destination_invalid'); }
        for (const file of manifest.files) {
          signal.throwIfAborted(); this.checkParent(grant);
          if (this.directory(directory.path).identity !== directory.identity) throw new Error('artifact_not_ready');
          const target = manifest.format === 'csv' ? join(temporary, file.path) : temporary;
          await this.copyFile(join(directory.path, file.path), target, signal, value => { if (manifest.format !== 'csv') owned = value; });
          await this.file(target, file, signal, join(directory.path, file.path));
        }
        signal.throwIfAborted(); this.checkParent(grant);
        if (owned !== identity(await lstat(temporary, { bigint: true }))) throw new Error('export_copy_failed');
        await this.verifyCopied(grant, input, temporary, manifest, signal);
        this.checkParent(grant);
        if (owned !== identity(await lstat(temporary, { bigint: true }))) throw new Error('export_copy_failed');
        await releaseTemporary?.(); releaseTemporary = null;
        await publishNoReplace(temporary, grant.target, manifest.format === 'csv' ? 'directory' : 'file', signal); published = true;
        await this.external(grant, manifest, directory.path); // Once published, finish verification even if cancellation arrives.
      } finally {
        await releaseTemporary?.();
        if (!published && owned !== null) {
          try {
            this.checkParent(grant); const stat = await lstat(temporary, { bigint: true });
            if (!stat.isSymbolicLink() && identity(stat) === owned) {
              if (manifest.format === 'csv') { for (const file of manifest.files) { try { await unlink(join(temporary, file.path)); } catch {} } await rmdir(temporary); }
              else await unlink(temporary);
            }
          } catch { /* Preserve files if temporary ownership or parent identity is no longer proven. */ }
        }
      }
    }
    const receipt = ExportCopyReceiptSchema.parse({ contract: 'medclaw.export-receipt/v2', operationRef: input.operationRef, exportId: input.exportId, artifactId: input.artifactId,
      verifiedAt: new Date(this.clock()).toISOString(), files: manifest.files.map(file => ({ name: file.path, bytes: file.bytes })) });
    await this.saveProof(receipt, manifest, grant); return receipt;
  }
  async cancel(operationRef: string) { OpaqueIdSchema.parse(operationRef); const active = this.active.get(operationRef); active?.controller.abort(); if (active) await active.promise.catch(() => {}); return { stopped: true }; }
  async settlePrevious() { this.tokens.clear(); const pending = [...this.active.values()]; for (const active of pending) active.controller.abort(); await Promise.allSettled(pending.map(active => active.promise)); return { stopped: true as const }; }
  closeWindow(windowId: number) { for (const [token, entry] of this.tokens) if (entry.windowId === windowId) this.tokens.delete(token); for (const active of this.active.values()) if (active.windowId === windowId) active.controller.abort(); }
  retainInstance(instanceId: string | null) { for (const [token, entry] of this.tokens) if (entry.instanceId !== instanceId) this.tokens.delete(token); for (const active of this.active.values()) if (active.instanceId !== instanceId) active.controller.abort(); }
}
