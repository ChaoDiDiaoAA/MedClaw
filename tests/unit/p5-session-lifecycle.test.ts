import { expect, test } from 'bun:test';
import * as session from '../../packages/contracts/src/session';
import { AppErrorSchema, safeError } from '../../packages/contracts/src/error';
import { HOST_PROTOCOL_VERSION, DATABASE_SCHEMA_VERSION, HostReadySchema, PublicHostRequestSchema, publicMethodSchemas, isReadOnlyMethod } from '../../packages/contracts/src/protocol';

const at = '2026-10-04T00:00:00.000Z';
const workspace = { revision: 1, sessionId: null, materialVersion: null, batchRefs: [], deviceIds: [], queryId: null, activeView: 'data', selection: null };
const metadata = { id: 1, title: '中文名称', status: 'active', metadataRevision: 0, deletedAt: null };
const rename = { sessionId: 1, title: ' 中文名称 ', expectedMetadataRevision: 0 };
const receipt = { operationRef: 'rename-1', method: 'session.rename', session: metadata, workspace: null, committedAt: at };

test('M01/M02 rename normalizes identity before validation and preserves user language', () => {
  expect(session.RenameSessionInputSchema).toBeDefined();
  expect(session.RenameSessionInputSchema.parse(rename)).toEqual({ ...rename, title: '中文名称' });
  for (const title of ['', ' \t\n ', 'x'.repeat(257)]) expect(session.RenameSessionInputSchema.safeParse({ ...rename, title }).success).toBe(false);
  expect(session.RenameSessionInputSchema.safeParse({ ...rename, title: 'x'.repeat(256) }).success).toBe(true);
  for (const expectedMetadataRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(session.RenameSessionInputSchema.safeParse({ ...rename, expectedMetadataRevision }).success).toBe(false);
  expect(session.RenameSessionInputSchema.safeParse({ ...rename, workspaceRevision: 0 }).success).toBe(false);
});

test('M04/M09 delete requires both independent CAS values', () => {
  expect(session.DeleteSessionInputSchema).toBeDefined();
  const input = { sessionId: 1, expectedMetadataRevision: 0, expectedWorkspaceRevision: 1 };
  expect(session.DeleteSessionInputSchema.parse(input)).toEqual(input);
  for (const value of [{ sessionId: 1, expectedMetadataRevision: 0 }, { sessionId: 0, expectedMetadataRevision: 0, expectedWorkspaceRevision: 1 }, { ...input, expectedWorkspaceRevision: -1 }]) expect(session.DeleteSessionInputSchema.safeParse(value).success).toBe(false);
});

test('M10/M14 management receipts bind method to lifecycle and Workspace semantics', () => {
  expect(session.SessionManagementReceiptSchema).toBeDefined();
  expect(session.SessionManagementReceiptSchema.safeParse(receipt).success).toBe(true);
  const deleted = { ...metadata, status: 'deleted', metadataRevision: 1, deletedAt: at };
  expect(session.SessionManagementReceiptSchema.safeParse({ ...receipt, method: 'session.delete', session: deleted, workspace }).success).toBe(true);
  for (const value of [{ ...receipt, workspace }, { ...receipt, method: 'session.delete', session: deleted }, { ...receipt, session: deleted }, { ...receipt, method: 'session.delete', workspace }, { ...receipt, model: 'injected' }]) expect(session.SessionManagementReceiptSchema.safeParse(value).success).toBe(false);
  for (const value of [{ ...metadata, deletedAt: at }, { ...deleted, deletedAt: null }, { ...metadata, status: 'archived' }]) expect(session.SessionMetadataViewSchema.safeParse(value).success).toBe(false);
});

test('M10 persisted management details reject mixed method and target identities', () => {
  expect(session.SessionManagementDetailsSchema).toBeDefined();
  const details = { format: 'medclaw.session-management/v1', originalRequest: { ...rename, title: '中文名称' }, receipt };
  expect(session.SessionManagementDetailsSchema.safeParse(details).success).toBe(true);
  expect(session.SessionManagementDetailsSchema.safeParse({ ...details, originalRequest: { ...details.originalRequest, sessionId: 2 } }).success).toBe(false);
  expect(session.SessionManagementDetailsSchema.safeParse({ ...details, originalRequest: { sessionId: 1, expectedMetadataRevision: 0, expectedWorkspaceRevision: 1 } }).success).toBe(false);
  expect(session.SessionManagementDetailsSchema.safeParse({ ...details, extra: true }).success).toBe(false);
});

test('M13/M15 management lookup is read only and protocol rejects the old Host', () => {
  expect(isReadOnlyMethod('session.readManagementOperation')).toBe(true);
  for (const method of ['session.rename', 'session.delete']) expect(isReadOnlyMethod(method)).toBe(false);
  const ready = { protocolVersion: HOST_PROTOCOL_VERSION, instanceId: 'host-1', sdkVersion: '0.87.1', schemaVersion: DATABASE_SCHEMA_VERSION, configVersion: '0', dataRoot: 'D:/fixture' };
  expect(HostReadySchema.safeParse(ready).success).toBe(true);
  expect(HostReadySchema.safeParse({ ...ready, protocolVersion: 'medclaw.host/p7-v1' }).success).toBe(false);
  expect(HostReadySchema.safeParse({ ...ready, schemaVersion: 5 }).success).toBe(false);
  for (const [method, payload] of [['session.rename', rename], ['session.delete', { sessionId: 1, expectedMetadataRevision: 0, expectedWorkspaceRevision: 1 }], ['session.readManagementOperation', { operationRef: 'rename-1' }]] as const) {
    expect(publicMethodSchemas[method]).toBeDefined();
    expect(PublicHostRequestSchema.safeParse({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', instanceId: 'host-1', requestId: 'request-1', operationRef: 'transport-1', method, payload }).success).toBe(true);
  }
});

test('M02 deleted and metadata conflict reasons survive safe public errors', () => {
  for (const reason of ['session_deleted', 'session_metadata_revision_mismatch'] as const) {
    const error = safeError('state_conflict', new Error('SECRET'), { reason, sessionId: 1 });
    expect(error.reason).toBe(reason);
    expect(AppErrorSchema.safeParse(error).success).toBe(true);
    expect(JSON.stringify(error)).not.toContain('SECRET');
    expect(error.message).not.toContain('identity');
  }
});
