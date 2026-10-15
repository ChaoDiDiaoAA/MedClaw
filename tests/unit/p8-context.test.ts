import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { publicMethodSchemas, isReadOnlyMethod } from '../../packages/contracts/src/protocol';
import { RegisteredEventDraftSchema } from '../../packages/contracts/src/event';
import { ToolContextIdentitySchema } from '../../packages/contracts/src/tool';
import { safeError } from '../../packages/contracts/src/error';
import { discoverTests, runStage } from '../run';
import { performance } from 'node:perf_hooks';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { ContextSnapshotBodySchema, ContextDeliveryObservationSchema } from '../../packages/contracts/src/context';
import { matchProviderContext } from '../../packages/runtime-pi/src/messages';

const at = '2026-10-05T00:00:00.000Z';
const envelope = { runId: 1, sessionId: 2, source: 'pi', sourceConnection: null, sourceSequence: null, toolCallId: null, occurredAt: at, receivedAt: at };

test('p8 manifest lock and actually resolved SDK packages stay on Pi 0.87.1',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../../packages/runtime-pi/package.json',import.meta.url),'utf8'));
  expect(manifest.dependencies['@earendil-works/pi-coding-agent']).toBe('0.87.1');expect(manifest.dependencies['@earendil-works/pi-ai']).toBe('0.87.1');
  const coding=Bun.resolveSync('@earendil-works/pi-coding-agent',import.meta.dir);
  for(const name of ['pi-coding-agent','pi-ai','pi-agent-core']) {
    let path=dirname(Bun.resolveSync(`@earendil-works/${name}`,dirname(coding)));while(!existsSync(join(path,'package.json')))path=dirname(path);
    const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));expect(pkg.name).toBe(`@earendil-works/${name}`);expect(pkg.version).toBe('0.87.1');
    expect(readFileSync(new URL('../../bun.lock',import.meta.url),'utf8')).toContain(`@earendil-works/${name}@0.87.1`);
  }
});

test('p8 payload matching uses exact user projection and trusted system text paths', () => {
  const snapshot = {renderedProjection:'materials',runtimeFeedback:'trusted feedback'}, user = {role:'user',content:'materials'}, system = {role:'system',content:'trusted feedback'};
  for (const [api,payload] of [
    ['openai-completions',{messages:[user,system]}], ['mistral-conversations',{messages:[user,system]}],
    ['openai-responses',{input:[{role:'user',content:[{type:'input_text',text:'materials'}]},system]}], ['azure-openai-responses',{input:[user,system]}],
    ['openai-codex-responses',{input:[user],instructions:'base\n\ntrusted feedback'}], ['anthropic-messages',{messages:[user],system:[{type:'text',text:'base\n\ntrusted feedback'}]}],
    ['bedrock-converse-stream',{messages:[{role:'user',content:[{text:'materials'}]}],system:[{text:'base\n\ntrusted feedback'}]}], ['pi-messages',{context:{messages:[user,system]}}],
  ] as const) expect(matchProviderContext(api,payload,snapshot)).toBe(true);
  for (const payload of [{messages:[user,{...system,role:'user'}]}, {messages:[user,user,system]}, {messages:[{...user,content:'materials altered'},system]}, {debug:{messages:[user,system]}}, {messages:[user,{...system,content:'prefix trusted feedback suffix'}]}]) expect(matchProviderContext('openai-completions',payload,snapshot)).toBe(false);
  expect(matchProviderContext('google-generative-ai',{messages:[user,system]},snapshot)).toBe(false);
});

test('p8 context read requires exactly one original identity', () => {
  const route = Reflect.get(publicMethodSchemas, 'context.read');
  expect(route).toBeDefined();
  expect(route.input.safeParse({ callId: 'call-1' }).success).toBe(true);
  expect(route.input.safeParse({ snapshotId: 7 }).success).toBe(true);
  for (const input of [{}, { snapshotId: 7, callId: 'call-1' }, { callId: 'call-1', sessionId: 3 }, { snapshotId: 0 }])
    expect(route.input.safeParse(input).success).toBe(false);
  expect(isReadOnlyMethod('context.read')).toBe(true);
});

test('p8 context event accepts model call IDs while tool events require numeric IDs', () => {
  const draft = { ...envelope, type: 'context_delivered', payload: { contract: 'medclaw.event/v1', snapshotId: 7, callId: 'call-1' } };
  expect(RegisteredEventDraftSchema.safeParse(draft).success).toBe(true);
  expect(RegisteredEventDraftSchema.safeParse({ ...draft, toolCallId: 7 }).success).toBe(false);
  const tool = { ...envelope, source: 'tool', toolCallId: 8, type: 'tool_started', payload: { contract: 'medclaw.event/v1', callId: 8, nativeToolCallId: 'tool-1', status: 'running', queryIds: [], errorCode: null } };
  expect(RegisteredEventDraftSchema.safeParse(tool).success).toBe(true);
  expect(RegisteredEventDraftSchema.safeParse({ ...tool, toolCallId: 9 }).success).toBe(false);
});

test('p8 tool context keeps the original call and snapshot together', () => {
  const identity = { runId: 1, sessionId: 2, nativeToolCallId: 'tool-1', scope: { batchIds: [], deviceIds: null, allowedToolNames: [], allowedResourceRefs: [], artifactIds: [], readOnly: false }, referenceDate: '2026-10-05', timezone: 'Asia/Shanghai', modelCallId: 'call-1', contextSnapshotId: 7 };
  expect(ToolContextIdentitySchema.parse(identity)).toMatchObject({ modelCallId: 'call-1', contextSnapshotId: 7 });
  expect(ToolContextIdentitySchema.safeParse({ ...identity, modelCallId: undefined }).success).toBe(false);
  expect(ToolContextIdentitySchema.safeParse({ ...identity, contextSnapshotId: null }).success).toBe(false);
});

test('p8 context errors identify the failed boundary without automatic retry', () => {
  for (const [code, category] of [['context_delivery_unsupported', 'provider'], ['context_payload_mismatch', 'runtime'], ['context_projection_too_large', 'input']])
    expect(safeError(code!)).toMatchObject({ code, category, retryable: false });
});

test('p8 runner discovers real tests and rejects zero execution', async () => {
  expect(discoverTests('unit', 'P8')).toContain(join(import.meta.dir, 'p8-context.test.ts'));
  const root = mkdtempSync(join(tmpdir(), 'medclaw-p8-runner-'));
  try {
    expect(await runStage('unit', 'P8', { root })).toMatchObject({ discovered: 0, executed: 0, exitCode: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('p8 admission preview has no side effects and commits once', () => {
  const control = new RunControl({runId:1,scope:{batchIds:[],deviceIds:null,allowedToolNames:[],allowedResourceRefs:[],artifactIds:[],readOnly:true},signal:new AbortController().signal,deadlineAt:performance.now()+60000});
  expect(typeof Reflect.get(control,'previewModelCall')).toBe('function');
  const preview = Reflect.get(control,'previewModelCall').call(control);
  expect(control.readBudget().modelCalls.used).toBe(0);
  expect(control.admitModelCall(preview)).toEqual({allowTools:preview.allowTools,feedback:preview.feedback});
  expect(control.readBudget().modelCalls.used).toBe(1);
  expect(() => control.admitModelCall(preview)).toThrow('state_conflict');
  expect(control.readBudget().modelCalls.used).toBe(1);
});

test('p8 stale cancelled expired and foreign previews never consume model budget', () => {
  const make = (controller = new AbortController(), deadlineAt = performance.now()+60000) => new RunControl({runId:1,scope:{batchIds:[],deviceIds:null,allowedToolNames:['read'],allowedResourceRefs:[],artifactIds:[],readOnly:true},signal:controller.signal,deadlineAt});
  const stale = make(), old = stale.previewModelCall();stale.observeToolAttempt('tool','read',{});
  expect(() => stale.admitModelCall(old)).toThrow('state_conflict');expect(stale.readBudget().modelCalls.used).toBe(0);
  const controller = new AbortController(), cancelled = make(controller), preview = cancelled.previewModelCall();controller.abort();
  expect(() => cancelled.admitModelCall(preview)).toThrow('tool_cancelled');expect(cancelled.readBudget().modelCalls.used).toBe(0);
  const expired = make(new AbortController(),performance.now()-1);expect(() => expired.previewModelCall()).toThrow('run_timeout');expect(expired.readBudget().modelCalls.used).toBe(0);
  const foreign = make();expect(() => foreign.admitModelCall(make().previewModelCall())).toThrow('state_conflict');expect(foreign.readBudget().modelCalls.used).toBe(0);
});

test('p8 strict context contracts reject over-budget bytes and unproven observations', () => {
  const body = {contract:'medclaw.context/v1',workspaceContext:null,selectedRefs:[],renderedProjection:'器械',runtimeFeedback:'',resourceVersions:{},nativeRefs:[],omitted:[],projectionLimitBytes:6};
  expect(ContextSnapshotBodySchema.safeParse(body).success).toBe(true);
  expect(ContextSnapshotBodySchema.safeParse({...body,projectionLimitBytes:5}).success).toBe(false);
  expect(ContextSnapshotBodySchema.safeParse({...body,id:1}).success).toBe(false);
  const observed = {contract:'medclaw.context-observation/v1',api:'openai-completions',transport:'sse',observedAt:at,httpStatus:200,verifiedNativeRefs:[]};
  expect(ContextDeliveryObservationSchema.safeParse(observed).success).toBe(true);
  expect(ContextDeliveryObservationSchema.safeParse({...observed,api:'bedrock-converse-stream',transport:'aws-event-stream'}).success).toBe(true);
  expect(ContextDeliveryObservationSchema.safeParse({...observed,api:'bedrock-converse-stream'}).success).toBe(false);
  for (const patch of [{httpStatus:500},{api:'google-generative-ai'},{transport:'websocket'},{verifiedNativeRefs:[{kind:'input',id:0}]}]) expect(ContextDeliveryObservationSchema.safeParse({...observed,...patch}).success).toBe(false);
});
