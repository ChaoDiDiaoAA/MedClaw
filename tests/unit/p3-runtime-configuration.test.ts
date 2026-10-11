import { expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { TOOL_CONFIG } from '../../packages/contracts/src/tool-config';
import { RUNTIME_CONFIG } from '../../packages/contracts/src/runtime-config';
import { RunControl } from '../../packages/core/src/runtime/run-control';
import { groupWorkload } from '../../packages/core/src/tools/tool-profile';
import { HOST_PROTOCOL_VERSION, publicMethodSchemas, createPublicMethodSchemas, encodeHostFrame, parseHostFrame } from '../../packages/contracts/src/protocol';

const scope = { batchIds: [1], deviceIds: null, allowedToolNames: ['read', 'bash'], allowedResourceRefs: [], artifactIds: [], readOnly: false };

test('Run control freezes the one runtime configuration and applies its budgets', () => {
  const configuration = structuredClone(RUNTIME_CONFIG);
  configuration.runBudget.maxToolCalls = 1;
  configuration.runBudget.maxModelCalls = 2;
  configuration.runBudget.timeoutMs = 10000;
  const control = new RunControl({ runId: 1, scope, signal: new AbortController().signal,
    deadlineAt: performance.now() + 10000, runtimeConfiguration: configuration, toolConfiguration: TOOL_CONFIG });
  configuration.runBudget.maxToolCalls = 9;
  expect(control.runtimeConfiguration.runBudget.maxToolCalls).toBe(1);
  control.observeToolAttempt('first', 'read', {});
  control.observeToolAttempt('second', 'read', {});
  expect(control.admitToolCall('second', 'read', {})?.code).toBe('tool_call_limit');
  expect(control.admitModelCall().allowTools).toBe(false);
  control.dispose();
});

test('an explicit native command timeout can shorten the common execution lease', () => {
  const configuration = structuredClone(RUNTIME_CONFIG);
  configuration.runBudget.timeoutMs = 10000;
  const control = new RunControl({ runId: 2, scope, signal: new AbortController().signal,
    deadlineAt: performance.now() + 10000, runtimeConfiguration: configuration });
  try {
    control.beginToolExecution('shell', 'bash', '0.87.1', { command: 'echo done', timeout: 0.01 });
    expect(control.observation('shell').effectiveTimeoutMs).toBe(10);
  } finally { control.dispose(); }
});

test('workload grouping uses fixed input buckets', () => {
  expect(groupWorkload({ pageSize: 40 }, scope, false)).toBe(groupWorkload({ pageSize: 80 }, scope, false));
  expect(groupWorkload({ pageSize: 40 }, scope, false)).not.toBe(groupWorkload({ pageSize: 200 }, scope, false));
});

test('transport preserves omitted defaults until the trusted fixed business contracts apply', () => {
  const payload = publicMethodSchemas['query.read'].input.parse({ queryId: 1 });
  expect(payload).toEqual({ queryId: 1 });
  const frame = parseHostFrame(encodeHostFrame({ protocolVersion: HOST_PROTOCOL_VERSION, kind: 'request', instanceId: 'fixture', requestId: 'read', operationRef: 'read', method: 'query.read', payload }), 'fixture');
  expect('payload' in frame && frame.payload).toEqual({ queryId: 1 });
  expect(createPublicMethodSchemas()['query.read'].input.parse(payload)).toEqual({ queryId: 1, page: 1, pageSize: 50 });
  const query = { kind: 'current' as const, population: 'snapshot' as const, snapshotMode: 'exact_date' as const, batchIds: [1] };
  const form=publicMethodSchemas['session.submit'].input.parse({mode:'send',sessionId:1,clientSequence:1,text:'Engineering form',
    expectedRevision:1,expectedBatchIds:[1],expectedQueryId:null,model:{provider:'fixture',modelId:'fixture',expectedConfigVersion:'1'},
    referenceDate:'2026-10-11',timezone:'Asia/Shanghai',routing:{mode:'user_form',params:query}});
  expect(form.mode==='send'&&form.routing?.mode==='user_form'&&form.routing.params).toMatchObject({...query,page:1,pageSize:50,sort:'asc',distributor:null});
});
