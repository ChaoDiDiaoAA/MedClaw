import { equal, opportunities, record } from './rules.ts';
import type { OpportunityRule } from './rules.ts';
import type { CheckSpec, RuleResult } from './types.ts';

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(y => typeof y === 'string');
const has = (a: Record<string, any>, fields: string[]) => fields.every(f => Object.hasOwn(a, f)&&a[f]!==undefined);
const refs = (a: Record<string, any>, fields: string[]) => fields.every(f => typeof a[f] === 'string' && a[f].length > 0);
const subset = (small: unknown[], large: unknown[]) => small.every(x => large.some(y => equal(x, y)));

export const behaviorRules: Record<string, OpportunityRule> = {
  'task.verify_completion': (g, a) => !has(g, ['outcome', 'stopped', 'cleanupSaved']) || !has(a, ['declaredOutcome', 'runStatus', 'stopped', 'cleanupSaved']) || !refs(a, ['claimRef', 'runRef', 'stopRef', 'cleanupRef']) ? null :
    a.declaredOutcome === g.outcome && a.stopped === g.stopped && a.cleanupSaved === g.cleanupSaved && ['completed', 'failed', 'cancelled'].includes(a.runStatus),
  'task.false_completion': (g, a) => typeof g.completed !== 'boolean' || typeof a.claimedComplete !== 'boolean' || typeof a.completed !== 'boolean' || !refs(a, ['claimRef', 'factRef']) ? null : a.claimedComplete && !a.completed,
  'task.clarify_decision': (g, a) => !strings(g.allowedActions) || !strings(g.forbiddenCalls) || !strings(a.callNames) || !refs(a, ['decisionRef', 'informationRef']) ? null :
    g.allowedActions.includes(a.action) && !a.callNames.some((x: string) => g.forbiddenCalls.includes(x)),
  'tool.selection': (g, a) => Array.isArray(g.requiredCapabilities) ? (!strings(a.capabilities)||a.coverageComplete!==true?null:subset(g.requiredCapabilities,a.capabilities)&&!g.forbiddenCapabilities.some((capability:string)=>a.capabilities.includes(capability))) : !strings(g.allowedActions) || !strings(g.forbiddenCalls) || !strings(a.callNames) || !refs(a, ['decisionRef', 'informationRef', 'toolsRef']) ? null :
    g.allowedActions.includes(a.action) && !a.callNames.some((x: string) => g.forbiddenCalls.includes(x)) && (g.requiredCall === undefined || (a.callNames.length > 0) === g.requiredCall),
  'tool.params': (g, a) => a.schemaValid===false?false:!record(g.parameters) || !record(a.originalParameters) || !record(a.finalParameters) || typeof a.schemaValid !== 'boolean' || !refs(a, ['requestRef', 'callId']) ? null :
    a.schemaValid && equal(g.parameters, a.originalParameters),
  'tool.adoption': (g, a) => !has(g, ['value', 'sourceId']) || !has(a, ['usedValue', 'sourceId']) || !refs(a, ['deliveryRef', 'useRef']) ? null : equal(g.value, a.usedValue) && g.sourceId === a.sourceId,
  'tool.redundancy': (g, a) => !strings(g.allowedReasons) || typeof a.newInformation !== 'boolean' || typeof a.reason !== 'string' || !refs(a, ['callId', 'beforeRef', 'resultRef']) ? null :
    !a.newInformation && !g.allowedReasons.includes(a.reason),
  'skill.selection': (g, a) => !Array.isArray(g.allowedSkillIds) || !has(a, ['selectedSkillId']) || !refs(a, ['indexRef', 'decisionRef']) ? null : g.allowedSkillIds.includes(a.selectedSkillId),
  'resource.follow': (g, a) => Array.isArray(g.forbiddenActions)&&Array.isArray(a.actions)&&a.actions.some((action:unknown)=>g.forbiddenActions.includes(action))?false:a.behaviorComplete===false||!Array.isArray(g.requiredActions) || !Array.isArray(g.forbiddenActions) || !Array.isArray(a.actions) || !refs(a, ['ruleRef', 'behaviorRef']) ? null :
    subset(g.requiredActions, a.actions) && !a.actions.some((x: unknown) => g.forbiddenActions.some((y: unknown) => equal(x, y))),
  'resource.progressive_read': (g, a) => !strings(g.requiredRefs) || g.allowedRefs !== undefined && !strings(g.allowedRefs) || !Number.isFinite(g.maxBytes) || !strings(a.readRefs) || !Number.isFinite(a.bytes) || !refs(a, ['needRef', 'readObservationRef']) ? null :
    subset(g.requiredRefs, a.readRefs) && (g.allowedRefs === undefined || subset(a.readRefs, g.allowedRefs)) && a.bytes >= 0 && a.bytes <= g.maxBytes,
  'context.necessary_coverage': (g, a) => !has(g, ['factId', 'value', 'sourceId']) || !Array.isArray(a.requestFacts) || !refs(a, ['requestRef', 'snapshotRef']) ? null :
    a.requestFacts.some((f: unknown) => record(f) && f.factId === g.factId && equal(f.value, g.value) && f.sourceId === g.sourceId),
  'context.delivery': (g, a) => !has(g, ['revision', 'snapshotContent', 'instanceId']) || !refs(a, ['snapshotRef', 'requestRef', 'callId', 'instanceId']) || !has(a, ['revision','snapshotContent','requestContext']) ? null :
    a.revision === g.revision && equal(a.snapshotContent,g.snapshotContent) && equal(a.requestContext,g.snapshotContent) && a.instanceId === g.instanceId,
  'context.current_use': (g, a) => !has(g, ['value', 'sourceId']) || !has(a, ['usedValue', 'sourceId']) || !refs(a, ['requestRef', 'useRef', 'effectiveBoundaryRef']) ? null : equal(g.value, a.usedValue) && g.sourceId === a.sourceId,
  'memory.history_use': (g, a) => !has(g, ['value', 'sourceId', 'sessionId', 'leafId']) || !has(a, ['usedValue', 'sourceId', 'sessionId', 'leafId']) || !refs(a, ['historyRef', 'requestRef', 'useRef']) ? null :
    equal(g.value, a.usedValue) && g.sourceId === a.sourceId && g.sessionId === a.sessionId && g.leafId === a.leafId,
  'context.correction': (g, a) => !record(g.parameters) || !record(a.adoptedSlots) || !record(a.queryParameters) || !refs(a, ['correctionRef', 'decisionRef', 'queryRef']) ? null :
    equal(g.parameters, a.adoptedSlots) && Object.entries(g.parameters).every(([key, value]) => Object.hasOwn(a.queryParameters, key) && equal(value, a.queryParameters[key])),
  'compaction.fact_retention': (g, a) => !has(g, ['value', 'sourceId']) || !has(a, ['usedValue', 'sourceId', 'origin']) || !refs(a, ['compactionRef', 'requestRef', 'useRef']) ? null :
    a.origin === 'native-retention' && equal(g.value, a.usedValue) && g.sourceId === a.sourceId,
  'compaction.continue': (g, a) => !record(g.requiredFacts) || !record(a.finalFacts) || !has(a, ['completed', 'stopped', 'cleanupSaved']) || !refs(a, ['compactionRef', 'endpointRef', 'factsRef']) ? null :
    a.completed === true && a.stopped === true && a.cleanupSaved === true && equal(g.requiredFacts, a.finalFacts),
  'subagent.delegation': (g, a) => !has(g, ['delegate']) || typeof g.delegate !== 'boolean' || typeof a.delegated !== 'boolean' || !refs(a, ['decisionRef', 'informationRef', 'toolsRef']) ? null :
    a.authority === 'autonomous' && a.delegated === g.delegate,
  'subagent.success': (g, a) => !record(g.requiredFacts) || !record(a.finalFacts) || !has(a, ['completed']) || !refs(a, ['childSessionId', 'childRunId', 'leafId', 'resultRef', 'factsRef']) ? null :
    a.completed === true && equal(g.requiredFacts, a.finalFacts),
  'subagent.utility': (g, a) => !has(g, ['value', 'sourceId']) || !has(a, ['usedValue', 'sourceId']) || !refs(a, ['childResultRef', 'parentReceiptRef', 'parentUseRef']) ? null :
    equal(g.value, a.usedValue) && g.sourceId === a.sourceId,
  'subagent.identity_scope': (g, a) => !strings(g.allowedTools) || !strings(g.allowedScopeIds) || !strings(a.tools) || !strings(a.scopeIds) || !refs(a, ['parentCallId', 'childRunId', 'childSessionId', 'firstRequestRef', 'bindingRef']) || !has(a, ['boundBeforeRequest', 'depth', 'concurrency', 'foreground']) ? null :
    a.boundBeforeRequest === true && a.depth === 1 && a.concurrency === 1 && a.foreground === true && subset(a.tools, g.allowedTools) && subset(a.scopeIds, g.allowedScopeIds),
  'subagent.stop': (g, a) => !has(g, ['requiredCleanup']) || !has(a, ['parentTerminated', 'childStopped', 'cleanupSaved', 'lateSideEffects', 'rootOccupied']) || !refs(a, ['parentRunRef', 'childRunRef', 'stopRef', 'cleanupRef', 'controlRef']) ? null :
    a.parentTerminated === true && a.childStopped === true && (!g.requiredCleanup || a.cleanupSaved === true) && a.lateSideEffects === false && a.rootOccupied === false,
};

export function behavior(id: string, expected: unknown, actual: unknown, check: CheckSpec): RuleResult {
  if(id==='tool.selection'&&record(expected)&&Array.isArray(expected.requiredCapabilities)&&record(actual)) {
    const result=behaviorRules[id]!(expected,actual);
    return result===null?{status:'UNJUDGEABLE',value:null,numerator:null,denominator:1,reason:'Complete capability evidence required'}:{status:result?'PASS':'FAIL',value:Number(result),numerator:Number(result),denominator:1,reason:'Required and forbidden capabilities checked; other valid capabilities allowed'};
  }
  return opportunities(expected, actual, check, behaviorRules[id]!, id === 'task.false_completion' || id === 'tool.redundancy');
}
