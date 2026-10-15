import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { z } from 'zod';
import { canonicalRequest } from '../../../packages/contracts/src/run.ts';
import { EXPORT_VERSION, ExportManifestSchema, type ExportArtifact } from '../../../packages/contracts/src/export.ts';
import type { Artifact } from '../../../packages/contracts/src/data.ts';
import { omitLegacyFields } from '../../../packages/storage/src/legacy-business-fields.ts';

export function within(root: string, path: string) {
  const part = relative(resolve(root), resolve(path));
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('path_outside_owned_root');
  return part;
}
export interface CopiedFile { relativePath: string; evidencePath: string; bytes: number; sensitivity: 'private'; content?:string }
/** Reject links at every component; only product inputs or registered artifacts call this. */
export async function copyEvidenceTree(sourceRoot: string, targetRoot: string): Promise<CopiedFile[]> {
  const source = resolve(sourceRoot), target = resolve(targetRoot);
  if (await realpath(source) !== source || (await lstat(source)).isSymbolicLink()) throw new Error('linked_source_rejected');
  const files: CopiedFile[] = [];
  async function visit(path: string) {
    const part = within(source, path), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('linked_source_rejected');
    if (stat.isDirectory()) { for (const name of (await readdir(path)).sort()) await visit(join(path, name)); return; }
    if (!stat.isFile()) throw new Error('non_file_source_rejected');
    if (await realpath(path) !== path) throw new Error('linked_source_rejected');
    const bytes = await readFile(path), after = await lstat(path);
    if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('source_changed_during_copy');
    const destination = join(target, part); within(target, destination); await mkdir(dirname(destination), { recursive: true });
    await copyFile(path, destination, constants.COPYFILE_EXCL);
    const copied = await readFile(destination);
    if (!copied.equals(bytes)) throw new Error('copied_file_content_mismatch');
    const content=copied.toString('utf8');if(!Buffer.from(content).equals(copied))throw new Error('artifact_utf8_invalid');
    files.push({ relativePath: part.replaceAll('\\', '/'), evidencePath: destination, bytes: copied.length, sensitivity: 'private',content });
  }
  await visit(source); return files;
}

type ArchivedArtifact={id:number;operationRef:string;protocolValidated:true};
export async function verifyCopiedArtifact(artifact: Artifact | ExportArtifact | ArchivedArtifact, files: CopiedFile[]) {
  if((artifact as any).protocolValidated===true) {
    const manifestFile=files.find(file=>file.relativePath==='manifest.json');if(!manifestFile)throw new Error('artifact_manifest_missing');
    const manifest=JSON.parse(await readFile(manifestFile.evidencePath,'utf8'));
    if(manifest.artifactId!==artifact.id||(manifest.operationRef??manifest.originOperationRef)!==artifact.operationRef||!Array.isArray(manifest.files))throw new Error('artifact_manifest_identity_mismatch');
    if(manifest.files.length+1!==files.length||new Set(manifest.files.map((file:any)=>file.path)).size!==manifest.files.length||new Set(files.map(file=>file.relativePath)).size!==files.length)throw new Error('artifact_file_set_mismatch');
    for(const file of files) {const bytes=await readFile(file.evidencePath);if(file.content===undefined||!bytes.equals(Buffer.from(file.content))||bytes.length!==file.bytes)throw new Error('artifact_content_mismatch');}
    for(const entry of manifest.files)if(!files.some(file=>file.relativePath===entry.path&&file.bytes===entry.bytes))throw new Error('artifact_file_set_mismatch');
    return;
  }
  if('protocolValidated' in artifact)throw new Error('artifact_protocol_unverified');
  const manifestFile = files.find(file => file.relativePath === 'manifest.json'); if (!manifestFile) throw new Error('artifact_manifest_missing');
  const manifestBytes = await readFile(manifestFile.evidencePath), value: unknown = JSON.parse(manifestBytes.toString('utf8'));
  const fileSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative() });
  let declared: z.infer<typeof fileSchema>[];
  if ('relativePath' in artifact) {
    let metadata=value;
    if(value&&typeof value==='object'&&'contract' in value&&value.contract==='medclaw.export-manifest/v1') {
      const legacy=omitLegacyFields(value,['resultHash','metadataHash']) as Record<string,unknown>;
      if(legacy.exportVersion!=='medclaw.export/v1')throw new Error('artifact_manifest_identity_mismatch');
      metadata={...legacy,contract:'medclaw.export-manifest/v2',exportVersion:EXPORT_VERSION,
        files:Array.isArray(legacy.files)?legacy.files.map(file=>omitLegacyFields(file,['sha256'])):legacy.files};
    }
    const manifest = ExportManifestSchema.parse(metadata); declared = manifest.files;
    if (manifest.artifactId !== artifact.id || manifest.originOperationRef !== artifact.operationRef || manifest.queryId !== artifact.queryId
      || manifest.format !== artifact.format) throw new Error('artifact_manifest_identity_mismatch');
  } else {
    const manifest = z.object({ schema: z.enum(['medclaw.artifact/import/v1','medclaw.artifact/import/v2']), artifactId: z.number().int().positive(), operationRef: z.string(),
      files: z.array(fileSchema) }).parse(value); declared = manifest.files;
    const legacy=omitLegacyFields(value,['sourceHash','metadataHash','sourceLockHash']) as Record<string,unknown>;
    const metadata=manifest.schema==='medclaw.artifact/import/v1'?{...legacy,
      files:(legacy.files as unknown[]).map(file=>omitLegacyFields(file,['sha256']))}:value;
    if (manifest.artifactId !== artifact.id || manifest.operationRef !== artifact.operationRef
      || canonicalRequest(metadata) !== canonicalRequest(artifact.metadata)) throw new Error('artifact_manifest_identity_mismatch');
  }
  if (files.length !== declared.length + 1||new Set(declared.map(file=>file.path)).size!==declared.length||new Set(files.map(file=>file.relativePath)).size!==files.length) throw new Error('artifact_file_set_mismatch');
  for (const expected of declared) {
    const copied = files.find(file => file.relativePath === expected.path);
    if (!copied || copied.bytes !== expected.bytes) throw new Error('artifact_file_set_mismatch');
  }
  for(const file of files){const bytes=await readFile(file.evidencePath);if(file.content===undefined||!bytes.equals(Buffer.from(file.content))||bytes.length!==file.bytes)throw new Error('artifact_content_mismatch');}
  const totalBytes = declared.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes !== ('sizeBytes' in artifact ? artifact.sizeBytes : artifact.bytes)) throw new Error('artifact_size_mismatch');
}

/** Preserve the registered originals byte for byte in the private evidence archive. */
export async function archiveArtifactFiles(files:CopiedFile[]) {
  for(const file of files) {
    const bytes=await readFile(file.evidencePath),content=bytes.toString('utf8');
    if(!Buffer.from(content).equals(bytes)||bytes.length!==file.bytes||file.content!==undefined&&file.content!==content)throw new Error('artifact_content_mismatch');
    file.content=content;
  }
  return files;
}
