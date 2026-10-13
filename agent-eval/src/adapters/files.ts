import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { z } from 'zod';
import { hashBytes } from './product-checksums.ts';
import { canonicalRequest } from '../../../packages/contracts/src/run.ts';
import { ExportManifestSchema, type ExportArtifact } from '../../../packages/contracts/src/export.ts';
import type { Artifact } from '../../../packages/contracts/src/data.ts';
import { csvRows,projectPublicEvidence } from '../data-format.ts';

export function within(root: string, path: string) {
  const part = relative(resolve(root), resolve(path));
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('path_outside_owned_root');
  return part;
}
export interface CopiedFile { relativePath: string; evidencePath: string; sha256?: string; bytes: number; sensitivity: 'private'; content?:string }
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
    const copied = await readFile(destination), sha256 = hashBytes(bytes);
    if (!copied.equals(bytes)) throw new Error('copied_file_content_mismatch');
    files.push({ relativePath: part.replaceAll('\\', '/'), evidencePath: destination, sha256, bytes: copied.length, sensitivity: 'private' });
  }
  await visit(source); return files;
}

type ArchivedArtifact={id:number;operationRef:string;protocolValidated:true};
export async function verifyCopiedArtifact(artifact: Artifact | ExportArtifact | ArchivedArtifact, files: CopiedFile[]) {
  if((artifact as any).protocolValidated===true) {
    const manifestFile=files.find(file=>file.relativePath==='manifest.json');if(!manifestFile)throw new Error('artifact_manifest_missing');
    const manifest=JSON.parse(await readFile(manifestFile.evidencePath,'utf8'));
    if(manifest.artifactId!==artifact.id||(manifest.operationRef??manifest.originOperationRef)!==artifact.operationRef||!Array.isArray(manifest.files)||manifest.files.length+1!==files.length)throw new Error('artifact_manifest_identity_mismatch');
    for(const file of files) {const bytes=await readFile(file.evidencePath);if(file.content===undefined||!bytes.equals(Buffer.from(file.content))||bytes.length!==file.bytes)throw new Error('artifact_content_mismatch');}
    for(const entry of manifest.files)if(!files.some(file=>file.relativePath===entry.path&&file.bytes===entry.bytes))throw new Error('artifact_file_set_mismatch');
    return;
  }
  if('protocolValidated' in artifact)throw new Error('artifact_protocol_unverified');
  const manifestFile = files.find(file => file.relativePath === 'manifest.json'); if (!manifestFile) throw new Error('artifact_manifest_missing');
  const manifestBytes = await readFile(manifestFile.evidencePath), value: unknown = JSON.parse(manifestBytes.toString('utf8'));
  const fileSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
  let declared: z.infer<typeof fileSchema>[];
  if ('relativePath' in artifact) {
    const manifest = ExportManifestSchema.parse(value); declared = manifest.files;
    if (manifest.artifactId !== artifact.id || manifest.originOperationRef !== artifact.operationRef || manifest.queryId !== artifact.queryId
      || manifest.format !== artifact.format || manifest.metadataHash !== artifact.metadataSha256 || hashBytes(canonicalRequest(manifest.files)) !== artifact.sha256) throw new Error('artifact_manifest_identity_mismatch');
  } else {
    const manifest = z.object({ schema: z.literal('medclaw.artifact/import/v1'), artifactId: z.number().int().positive(), operationRef: z.string(),
      sourceHash: z.string(), files: z.array(fileSchema) }).parse(value); declared = manifest.files;
    if (manifest.artifactId !== artifact.id || manifest.operationRef !== artifact.operationRef || manifest.sourceHash !== artifact.sha256
      || hashBytes(canonicalRequest(manifest.files.map(file => ({ ...file, path: file.path.slice(6) })))) !== artifact.sha256
      || canonicalRequest(value) !== canonicalRequest(artifact.metadata)) throw new Error('artifact_manifest_identity_mismatch');
  }
  if (files.length !== declared.length + 1) throw new Error('artifact_file_set_mismatch');
  for (const expected of declared) {
    const copied = files.find(file => file.relativePath === expected.path);
    if (!copied || copied.sha256 !== expected.sha256 || copied.bytes !== expected.bytes) throw new Error('artifact_file_hash_mismatch');
  }
  const totalBytes = declared.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes !== ('sizeBytes' in artifact ? artifact.sizeBytes : artifact.bytes)) throw new Error('artifact_size_mismatch');
}

/** Verify product checksums first, then archive an explicit content projection. */
export async function archiveArtifactFiles(files:CopiedFile[]) {
  for(const file of files) {
    let content=await readFile(file.evidencePath,'utf8');
    if(file.relativePath.endsWith('.json'))content=JSON.stringify(projectPublicEvidence(JSON.parse(content)),null,2)+'\n';
    else if(file.relativePath.endsWith('.csv')) {
      const rows=csvRows(content),column=rows[0]!.indexOf('source_refs_json');
      if(column>=0) {for(const row of rows.slice(1))row[column]=JSON.stringify(projectPublicEvidence(JSON.parse(row[column]!)));content=rows.map(row=>row.map(cell=>/[",\r\n]/.test(cell)?'"'+cell.replaceAll('"','""')+'"':cell).join(',')).join('\n')+'\n';}
    }
    file.content=content;file.bytes=Buffer.byteLength(content);delete file.sha256;
  }
  const manifestFile=files.find(file=>file.relativePath==='manifest.json');
  if(manifestFile) {const manifest=JSON.parse(manifestFile.content!);manifest.files=manifest.files.map((entry:any)=>{const file=files.find(file=>file.relativePath===entry.path);if(!file)throw new Error('artifact_file_set_mismatch');return {...entry,bytes:file.bytes};});manifestFile.content=JSON.stringify(manifest,null,2)+'\n';manifestFile.bytes=Buffer.byteLength(manifestFile.content);}
  for(const file of files)await import('node:fs/promises').then(fs=>fs.writeFile(file.evidencePath,file.content!,{mode:0o600}));
  return files;
}
