import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage } from '../run';
import { publicMethodSchemas, PublicHostRequestSchema, HOST_PROTOCOL_VERSION } from '../../packages/contracts/src/protocol';
import { safeError } from '../../packages/contracts/src/error';
import { ModelCallContextSchema, RegisterContextDeliveryInputSchema } from '../../packages/contracts/src/context';
import { ChildResultSchema, ChildResultViewSchema, BoundChildIdentitySchema } from '../../packages/contracts/src/subagent';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { normalizeRuntimeConfiguration } from '../../packages/contracts/src/runtime-config';
import { performance } from 'node:perf_hooks';
import { matchProviderContext } from '../../packages/runtime-pi/src/messages';
import {RunEventProjection} from '../../apps/desktop/src/renderer/use-run-events';
import type {EventPage,MessageStreamSnapshot,StoredRunEvent} from '../../packages/contracts/src/event';

test('p13 subagent contracts can be imported first in a fresh process', () => {
  const probe=Bun.spawnSync([process.execPath,'--eval',"import {ChildResultSchema,FrozenChildConfigSchema} from './packages/contracts/src/subagent.ts'; if (!ChildResultSchema || !FrozenChildConfigSchema) throw new Error('missing public schema'); console.log('ready')"],{cwd:join(import.meta.dir,'../..')});
  expect(probe.exitCode).toBe(0);
  expect(probe.stdout.toString().trim()).toBe('ready');
});

test('p13 delegated payload proof requires the actual prompt alongside projection and trusted feedback', () => {
  const prompt='ENGINEERING delegated prompt',source={parentRunId:1,originToolCallId:2,parentSnapshotId:3,parentInputId:4,
    nativeEntryId:'child-input'};
  const snapshot={renderedProjection:'ENGINEERING projection',runtimeFeedback:'ENGINEERING feedback',delegationSource:source};
  const messages=[{role:'system',content:snapshot.runtimeFeedback},{role:'user',content:snapshot.renderedProjection}];
  expect(matchProviderContext('openai-completions',{messages},snapshot,prompt)).toBe(false);
  expect(matchProviderContext('openai-completions',{messages:[...messages,{role:'user',content:prompt}]},snapshot,prompt)).toBe(true);
  expect(matchProviderContext('openai-completions',{messages:[...messages,{role:'user',content:'changed prompt'}]},snapshot,prompt)).toBe(false);
  expect(matchProviderContext('openai-completions',{messages:[...messages,{role:'user',content:prompt},{role:'user',content:prompt}]},snapshot,prompt)).toBe(false);
});

test('p13 child control shares root limits, reserves a parent call and isolates native attempt identities', () => {
  const scope = { batchIds: [1], deviceIds: [2], allowedToolNames: ['read'], allowedResourceRefs: [], artifactIds: [], readOnly: true };
  const rootAbort = new AbortController(), childAbort = new AbortController();
  const configuration = normalizeRuntimeConfiguration();
  configuration.runBudget.maxModelCalls = 4; configuration.runBudget.maxToolCalls = 2;
  const root = new RunControl({ runId: 1, scope, signal: rootAbort.signal, deadlineAt: performance.now() + 60000, runtimeConfiguration: configuration });
  root.admitModelCall();
  const child = root.createChild(2, scope, childAbort.signal);
  expect(() => child.createChild(3, scope, new AbortController().signal)).toThrow('access_denied');
  expect(() => root.createChild(3, { ...scope, batchIds: [1, 9] }, new AbortController().signal)).toThrow('access_denied');
  const staleParentPreview = root.previewModelCall();
  child.admitModelCall();
  expect(() => root.admitModelCall(staleParentPreview)).toThrow('state_conflict');
  child.admitCompactionCall();
  expect(() => child.admitModelCall()).toThrow('agent_call_limit');
  expect(() => root.createChild(3, scope, new AbortController().signal)).toThrow('agent_call_limit');
  root.admitModelCall();
  expect(root.readBudget().modelCalls).toMatchObject({ used: 4, remaining: 0 });
  expect(child.summary().modelCalls).toBe(2);
  expect(root.summary().modelCalls).toBe(2);
  root.observeToolAttempt('same-native-id', 'read', { path: 'parent' });
  child.observeToolAttempt('same-native-id', 'read', { path: 'child' });
  expect(root.readBudget().toolCalls).toMatchObject({ used: 2, remaining: 0 });
  expect(root.summary().toolCalls).toBe(1); expect(child.summary().toolCalls).toBe(1);
  rootAbort.abort(); expect(() => child.checkActive()).toThrow('tool_cancelled');
});

test('p13 runner rejects empty execution, required skips and discovery errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p13-runner-'));
  const directory = join(root, 'tests', 'unit');
  mkdirSync(directory, { recursive: true });
  try {
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 0, exitCode: 1 });
    const file = join(directory, 'p13-probe.test.ts');
    writeFileSync(file, "import { test } from 'bun:test'; test.skip('required', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 0, skip: 1, exitCode: 1 });
    writeFileSync(file, "import { test } from 'bun:test'; test('executed', () => {}); test.skip('required', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ executed: 1, skip: 1, exitCode: 1 });
    writeFileSync(file, "throw new Error('ENGINEERING discovery failure');");
    expect((await runStage('unit', 'P13', { root })).exitCode).toBe(1);
    writeFileSync(file, "import { test } from 'bun:test'; test('executed', () => {});");
    expect(await runStage('unit', 'P13', { root })).toMatchObject({ discovered: 1, executed: 1, pass: 1, skip: 0, exitCode: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test('p13 public child reads bind the child owner and reject mixed user or parent selection identities', () => {
  const history = publicMethodSchemas['session.messages.read'].input;
  expect(history.safeParse({ childRunId: 9 }).success).toBe(true);
  expect(history.safeParse({ childRunId: 9, sessionId: 1 }).success).toBe(false);
  expect(history.safeParse({ sessionId: 1 }).success).toBe(true);
  expect(history.safeParse({ childRunId: 0 }).success).toBe(false);
  const queries=publicMethodSchemas['query.list'].input;
  expect(queries.safeParse({childRunId:9}).success).toBe(true);
  expect(queries.safeParse({childRunId:9,sessionId:1}).success).toBe(false);
  const runs = publicMethodSchemas['run.read'].input;
  expect(runs.safeParse({ recent: true, parentRunId: 3 }).success).toBe(true);
  expect(runs.safeParse({ recent: true, parentRunId: 3, sessionId: 1 }).success).toBe(false);
  expect(runs.safeParse({ recent: true, parentRunId: 3, kind: 'agent' }).success).toBe(false);
  const frame = { protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', requestId: 'read_child', instanceId: 'host', operationRef: 'read', method: 'run.read', payload: { recent: true, parentRunId: 3 } };
  expect(PublicHostRequestSchema.safeParse(frame).success).toBe(true);
  expect(PublicHostRequestSchema.safeParse({ ...frame, protocolVersion: 'medclaw.host/p12-v1' }).success).toBe(false);
});

test('p13 child event sequence, snapshot revision and late cleanup metadata stay independent from the parent',()=>{
  const child=new RunEventProjection(2,3),parent=new RunEventProjection(1,1),time='2026-10-07T00:00:00Z';
  const created:StoredRunEvent={eventId:20,sequence:1,runId:2,sessionId:3,type:'run_created',payload:{contract:'medclaw.event/v1',sessionId:3,kind:'child',configVersion:'1'},source:'application',sourceConnection:null,sourceSequence:null,toolCallId:null,occurredAt:time,receivedAt:time};
  const page:EventPage={runId:2,events:[created],nextSequence:1,hasMore:false,range:{firstSequence:1,lastSequence:1}};
  expect(parent.applyPage(page)).toBe(false);expect(child.applyPage({...page,events:[{...created,sequence:2}],nextSequence:2})).toBe(false);expect(child.state.cursor).toBe(0);
  expect(child.applyPage(page)).toBe(true);expect(child.applyPage(page)).toBe(true);expect(child.state.events).toHaveLength(1);
  const stream:MessageStreamSnapshot={type:'message.snapshot',runId:2,sessionId:3,streamConnection:'child-connection',messageId:'same-id',ordinal:1,revision:2,phase:'streaming',modelCallId:'child-call',nativeEntryId:null,blocks:[{contentIndex:0,text:'ORIGINAL'}],totalChars:8,truncated:false};
  child.applySnapshot(stream);child.applySnapshot({...stream,revision:1,blocks:[{contentIndex:0,text:'OLD'}]});child.applySnapshot({...stream,streamConnection:'parent-connection',revision:10});parent.applySnapshot(stream);
  expect(child.state.cursor).toBe(1);expect(parent.state.snapshots).toHaveLength(0);
  const ended:StoredRunEvent={...created,eventId:21,sequence:2,type:'run_completed',payload:{contract:'medclaw.event/v1',stopConfirmed:true,answerId:null,errorCode:null}};
  expect(child.applyPage({...page,events:[ended],nextSequence:2})).toBe(true);child.replaceAuthoritative('saved');
  child.applySnapshot({...stream,revision:3,phase:'ended',nativeEntryId:'saved-child-entry',blocks:[{contentIndex:0,text:'LATE MUTATION'}]});child.applySnapshot({...stream,revision:4,messageId:'late-new'});
  expect(child.state.terminal).toBe(true);expect(child.state.snapshots).toHaveLength(1);expect(child.state.snapshots[0]).toMatchObject({revision:3,phase:'ended',nativeEntryId:'saved-child-entry',blocks:[{text:'ORIGINAL'}]});expect(child.state.nativeEntries).toHaveProperty('message:child-connection/same-id','native:saved-child-entry');
});

test('p13 committed execution delivery failure stays safe and cannot trigger automatic execution retry', () => {
  const error = safeError('tool_delivery_failed', new Error('ENGINEERING private payload'), { runId: 3, sessionId: 1 });
  expect(error).toMatchObject({ code: 'tool_delivery_failed', category: 'tool', retryable: false, runId: 3, sessionId: 1 });
  expect(error.message).not.toContain('private payload');
  for (const reason of ['subagent_binding_failed', 'subagent_limit', 'subagent_execution_failed'] as const) {
    expect(safeError(reason === 'subagent_limit' ? 'state_conflict' : 'internal_error', undefined, { runId: 3, reason })).toHaveProperty('reason', reason);
  }
});

test('p13 model context keeps positive user input distinct from null delegated input', () => {
  const base = { contract: 'medclaw.context-call/v1', snapshotId: 4, observation: null, responseStatus: null, payloadVerified: null };
  const source = { parentRunId: 1, originToolCallId: 2, parentSnapshotId: 3, parentInputId: 4,  nativeEntryId: 'child-prompt' };
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: 4 }).success).toBe(true);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: null, delegationSource: source }).success).toBe(true);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: null }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: 4, delegationSource: source }).success).toBe(false);
  expect(ModelCallContextSchema.safeParse({ ...base, inputId: 0 }).success).toBe(false);
  // Source identity cannot replace the child owner at an HTTP delivery boundary.
  expect(RegisterContextDeliveryInputSchema.safeParse({ runId: 9, sessionId: 10, inputId: null, delegationSource: source, callId: 'call', snapshotId: 11, observation: {} }).success).toBe(false);
});

test('p13 committed child JSON retains original reply only internally and rejects forged user identity or executable values', () => {
  const identity = { instanceId: 'host', parentRunId: 1, parentSessionId: 2, originToolCallId: 3, originNativeToolCallId: 'original-call', pluginAgentId: 'plugin-child', nativeSessionId: 'native-child', childRunId: 4, childSessionId: 5 };
  expect(BoundChildIdentitySchema.safeParse(identity).success).toBe(true);
  expect(BoundChildIdentitySchema.safeParse({ ...identity, childSessionId: 2 }).success).toBe(false);
  const result = { contract: 'medclaw.child-result/v1', childRunId: 4, childSessionId: 5, parentRunId: 1, originToolCallId: 3, pluginAgentId: 'plugin-child', nativeSessionId: 'native-child', outcome: 'failed', text: '', queryRefs: [], evidenceIds: [], gaps: ['ENGINEERING failed'], truncated: false, originalReply: { content: [{ type: 'text', text: 'original reply' }], details: {} },  finalLeafId: null, storageVersion: 1, committedAt: '2026-10-07T00:00:00.000Z' };
  expect(ChildResultSchema.safeParse(result).success).toBe(true);
  const { originalReply, ...view } = result;
  expect(ChildResultViewSchema.safeParse(view).success).toBe(true);
  expect(ChildResultViewSchema.safeParse(result).success).toBe(false);
  expect(ChildResultSchema.safeParse({ ...result, inputId: 1 }).success).toBe(false);
  expect(ChildResultSchema.safeParse({ ...result, originalReply: { ...originalReply, details: { action: () => {} } } }).success).toBe(false);
  expect(ChildResultSchema.safeParse({ ...result, queryRefs: [{ queryId: 1}, { queryId: 1}] }).success).toBe(false);
});
