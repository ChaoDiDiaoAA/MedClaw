import { expect, test } from 'bun:test';
import { ImportCommitRequestSchema } from '../../packages/contracts/src/data';
import { ResourceRefSchema } from '../../packages/contracts/src/resources';
import { IntentModelConfigurationSchema } from '../../packages/contracts/src/model';
import { ExportManifestSchema } from '../../packages/contracts/src/export';
import { HOST_PROTOCOL_VERSION, HostPrivateRequestSchema, PublicHostRequestSchema } from '../../packages/contracts/src/protocol';

test('copy content verification is a Host private command with a bounded absolute path', () => {
  const request = { protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'verify-copy', instanceId: 'host',
    operationRef: 'export:original', method: 'export.copy.verify',
    payload: { operationRef: 'export:original', exportId: 1, artifactId: 2, temporaryPath: 'D:/delivery/candidate.tmp' } };
  expect(HostPrivateRequestSchema.safeParse(request).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse(request).success).toBe(false);
  expect(HostPrivateRequestSchema.safeParse({ ...request, payload: { ...request.payload, temporaryPath: '../outside' } }).success).toBe(false);
});

test('import confirmation uses the authorized original operation without a content token', () => {
  const request = { operationRef: 'import:original', fileToken: 'authorized-directory' };
  expect(ImportCommitRequestSchema.parse(request)).toEqual(request);
  expect(ImportCommitRequestSchema.safeParse({ ...request, extraPath: 'C:/private' }).success).toBe(false);
});

test('resource selection uses its published business identity and rejects unrecognized metadata', () => {
  const ref = {kind:'skill',id:'query',version:'v1'} as const;
  expect(ResourceRefSchema.parse(ref)).toEqual(ref);
  expect(ResourceRefSchema.safeParse({ ...ref, file: '../outside' }).success).toBe(false);
});

test('intent model activation requires protocol evidence without requiring a weight digest', () => {
  const configuration = { contract: 'medclaw.intent-model/v2', enabled: true, baseUrl: 'http://127.0.0.1:11434',
    modelTag: 'qwen3.5:0.8b', sourceUrl: 'https://ollama.com/library/qwen3.5:0.8b',
    verifiedEvidenceRef: 'local-protocol-check', timeoutMs:15000} as const;
  expect(IntentModelConfigurationSchema.parse(configuration)).toEqual(configuration);
  expect(IntentModelConfigurationSchema.safeParse({ ...configuration, verifiedEvidenceRef: null }).success).toBe(false);
  expect(IntentModelConfigurationSchema.safeParse({ ...configuration, modelTag: 'other:tag' }).success).toBe(false);
});

test('export manifest binds business IDs and requires the complete fixed file set', () => {
  const manifest = { contract: 'medclaw.export-manifest/v2', artifactId: 12, originOperationRef: 'export:original',
    queryId: 7, answerId: null, format: 'csv', exportVersion: 'medclaw.export/v2',
    files: [{ path: 'result.csv', bytes: 3 }, { path: 'metadata.json', bytes: 2 }] };
  expect(ExportManifestSchema.parse(manifest)).toEqual({...manifest,contract:'medclaw.export-manifest/v2',format:'csv',exportVersion:'medclaw.export/v2',files:[{path:'result.csv',bytes:3},{path:'metadata.json',bytes:2}]});
  expect(ExportManifestSchema.safeParse({ ...manifest, files: manifest.files.slice(0, 1) }).success).toBe(false);
});
