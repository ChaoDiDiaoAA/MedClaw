import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as workspace from '../../packages/contracts/src/workspace';
import { DataRowsSchema } from '../../packages/contracts/src/data';
import * as query from '../../packages/contracts/src/query';
import { ToolContextIdentitySchema } from '../../packages/contracts/src/tool';
import { businessToolSchemas } from '../../packages/contracts/src/business-tools';
import { DATABASE_SCHEMA_VERSION, HOST_PROTOCOL_VERSION, HostRequestSchema, isReadOnlyMethod } from '../../packages/contracts/src/protocol';
import { SDK_VERSION } from '../../packages/contracts/src/model';
import { discoverTests, runStage } from '../run';

const hash = 'a'.repeat(64);
const state = { revision: 2, sessionId: 1, materialVersion: null, batchRefs: [], deviceIds: [], queryId: null, activeView: 'data' as const, selection: null };
const selection = { formatVersion: 1, kind: 'device', targetId: '7', targetVersion: hash, rowKey: 'snapshot:11', field: null };
const scope = { batchIds: [], deviceIds: null, artifactIds: [], allowedToolNames: [], allowedResourceRefs: [], readOnly: false };
const identity = { runId: 1, sessionId: 1, nativeToolCallId: 'tool-1', scope, referenceDate: '2026-10-04', timezone: 'Asia/Shanghai' };

test('four selection kinds accept their stable identity combinations', () => {
  for (const selected of [selection, { ...selection, kind: 'change', rowKey: 'change:11', field: 'deltaCents' },
    { ...selection, kind: 'query-row', rowKey: `row:${hash}`, field: 'value' }, { ...selection, kind: 'evidence', rowKey: null },
    { ...selection, kind: 'query-row', rowKey: 'snapshot:11', field: 'priceCents' }, { ...selection, kind: 'query-row', rowKey: 'change:11', field: 'ratio' },
    { ...selection, kind: 'evidence', rowKey: 'snapshot:11', field: 'priceCents' }]) {
    expect(workspace.WorkspaceChangeSchema.safeParse({ selection: selected }).success).toBe(true);
  }
});

test('selection rejects noncanonical identities, malformed hashes, incompatible row keys and unsafe fields', () => {
  const invalid = [{ targetId: '0' }, { targetId: '01' }, { targetId: '-1' }, { targetId: '1.0' }, { targetId: '9007199254740992' },
    { targetVersion: 'not-a-hash' }, { targetVersion: 'A'.repeat(64) }, { rowKey: null }, { rowKey: 'snapshot:0' }, { rowKey: 'snapshot:01' },
    { rowKey: 'change:11' }, { rowKey: '11' }, { field: '__proto__' }, { field: 'constructor' }, { field: 'prototype' }, { field: 'nested.priceCents' }, { field: '' },
    { kind: 'change', rowKey: 'snapshot:11' }, { kind: 'evidence', rowKey: null, field: 'priceCents' }, { formatVersion: 2 }, { extra: true }];
  for (const patch of invalid) expect(workspace.WorkspaceChangeSchema.safeParse({ selection: { ...selection, ...patch } }).success).toBe(false);
});

test('renderer patches cannot forge state, scope or restore metadata', () => {
  for (const field of ['sessionId', 'batchRefs', 'materialVersion', 'revision', 'notices', 'scope']) {
    expect(workspace.WorkspaceChangeSchema.safeParse({ [field]: null }).success).toBe(false);
  }
  expect(workspace.WorkspaceChangeSchema.safeParse({}).success).toBe(true);
  expect(workspace.WorkspaceChangeSchema.safeParse({ batchIds: [1, 1] }).success).toBe(false);
  expect(workspace.WorkspaceChangeSchema.safeParse({ batchIds: [2, 1] }).success).toBe(true);
});

test('legacy null state remains readable and freeze projects away transient notices', () => {
  expect(workspace.WorkspaceViewSchema.safeParse(state).success).toBe(true);
  const view = { ...state, notices: [{ code: 'reference_cleared', kind: 'query', targetId: '7' }] };
  expect(workspace.WorkspaceViewSchema.safeParse(view).success).toBe(true);
  expect(workspace.toWorkspaceContext(view)).toEqual(state);
  expect(workspace.WorkspaceContextSchema.safeParse(view).success).toBe(false);
  expect(workspace.WorkspaceContextSchema.safeParse({ ...state, sessionId: null }).success).toBe(false);
});

test('desktop Query sidecars align while business QueryPage rejects desktop fields', () => {
  const page = { queryId: 7, rows: [{ value: 4 }], totalRows: 1, page: 1, pageSize: 20, warnings: [], calculationVersion: 'v1', evidenceIds: [] };
  expect(query.QueryPageSchema.safeParse(page).success).toBe(true);
  const desktop = { ...page, targetVersion: hash, rowKeys: [`row:${hash}`] };
  expect(typeof query.DesktopQueryPageSchema).toBe('object');
  expect(query.DesktopQueryPageSchema.safeParse(desktop).success).toBe(true);
  expect(query.QueryPageSchema.safeParse(desktop).success).toBe(false);
  expect(query.DesktopQueryPageSchema.safeParse({ ...desktop, rowKeys: [] }).success).toBe(false);
  expect(query.DesktopQueryPageSchema.safeParse({ ...desktop, rowKeys: ['row:invalid'] }).success).toBe(false);
  expect(DataRowsSchema.safeParse({ kind: 'devices', items: [], selections: [], totalRows: 0, page: 1, pageSize: 20 }).success).toBe(true);
  expect(DataRowsSchema.safeParse({ kind: 'devices', items: [], selections: [selection], totalRows: 0, page: 1, pageSize: 20 }).success).toBe(false);
});

test('tool identity accepts legacy context but new frozen fields require a complete consistent group', () => {
  expect(ToolContextIdentitySchema.safeParse(identity).success).toBe(true);
  const frozen = { ...identity, workspaceContext: state, workspaceInputId: 3, basedOnQueryId: null, workspaceRevision: 2 };
  expect(ToolContextIdentitySchema.safeParse(frozen).success).toBe(true);
  for (const key of ['workspaceContext', 'workspaceInputId', 'basedOnQueryId', 'workspaceRevision']) {
    const incomplete = { ...frozen }; delete incomplete[key as keyof typeof incomplete];
    expect(ToolContextIdentitySchema.safeParse(incomplete).success).toBe(false);
  }
  for (const patch of [{ workspaceContext: null }, { workspaceContext: { ...state, sessionId: 2 } }, { workspaceRevision: 3 }, { basedOnQueryId: 7 }])
    expect(ToolContextIdentitySchema.safeParse({ ...frozen, ...patch }).success).toBe(false);
  expect(ToolContextIdentitySchema.safeParse({ ...frozen, workspaceInputId: null }).success).toBe(true);
});

test('read_data_scope delivers strict frozen references', () => {
  const output = { scope, referenceDate: '2026-10-04', timezone: 'Asia/Shanghai', workspaceContext: state, workspaceInputId: 3 };
  expect(businessToolSchemas.read_data_scope.output.safeParse(output).success).toBe(true);
  expect(businessToolSchemas.read_data_scope.output.safeParse({ ...output, scopeOverride: {} }).success).toBe(false);
});

test('protocol rejects pre-P7 frames and restore requires write uncertainty handling', () => {
  const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', instanceId: 'host-1', requestId: 'request-1', operationRef: 'operation-1', method: 'workspace.restore', payload: {} };
  expect(HostRequestSchema.safeParse(frame).success).toBe(true);
  expect(HostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p6-v1' }).success).toBe(false);
  expect(isReadOnlyMethod('workspace.restore')).toBe(false);
  expect(isReadOnlyMethod('workspace.read')).toBe(true);
  expect(DATABASE_SCHEMA_VERSION).toBe(5); expect(SDK_VERSION).toBe('0.87.1');
});

test('P7 runner discovers all categories and refuses empty discovery or zero execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p7-runner-'));
  try {
    expect(() => discoverTests('unit', 'P7', root)).not.toThrow();
    for (const category of ['unit', 'integration', 'e2e'] as const) {
      mkdirSync(join(root, 'tests', category), { recursive: true });
      expect((await runStage(category, 'P7', { root })).exitCode).toBe(1);
      writeFileSync(join(root, 'tests', category, `p7-empty.${category === 'e2e' ? 'spec' : 'test'}.ts`), 'export {};');
      expect(discoverTests(category, 'P7', root)).toHaveLength(1);
    }
    expect((await runStage('unit', 'P7', { root })).exitCode).toBe(1);
    expect((await runStage('integration', 'P7', { root })).exitCode).toBe(1);
    // Playwright's no-test case uses the real project dependency resolution.
    expect((await runStage('e2e', 'P7', { root })).exitCode).toBe(1);
    for (const stage of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) expect(() => discoverTests('unit', stage, root)).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
