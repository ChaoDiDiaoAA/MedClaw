import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectPublicEvidence } from '../data-format.ts';
import { ProductAdapter, unwrap } from '../adapters/product.ts';
import { listAllInputs, readAllMessages, type AliasState } from '../adapters/actions.ts';
import { copyEvidenceTree, verifyCopiedArtifact,archiveArtifactFiles } from '../adapters/files.ts';
import { readControllerOriginal } from '../adapters/controller-evidence.ts';
import type { VerifiedObservation } from '../types.ts';
import type { PublicMethod, PublicPayload, PublicReturn } from '../../../packages/contracts/src/protocol.ts';
import type { SessionCheckpointPage } from '../../../packages/contracts/src/session.ts';
import type { EventPage } from '../../../packages/contracts/src/event.ts';
import {QueryInventoryOriginalSchema} from '../../../packages/contracts/src/controller-evidence.ts';
import {IntentReadResultSchema} from '../../../packages/contracts/src/intent.ts';
import {hashBytes} from '../adapters/product-checksums.ts';
import {TOOL_READ_RULES} from '../../../packages/contracts/src/tool.ts';

/** Read every saved query in the original Run, including results omitted from the answer. */
export async function readQueryInventory(product:ProductAdapter,runs:{id:number;sessionId:number|null;instanceId:string}[]) {
  const queryIds=new Set<number>(),originals=[];
  for(const run of runs){
    if(run.sessionId===null)continue;
    const value=await readControllerOriginal(product,{kind:'queries',runId:run.id,sessionId:run.sessionId},run.instanceId);
    const inventory=QueryInventoryOriginalSchema.parse(value.original);
    if(inventory.instanceId!==run.instanceId||inventory.runId!==run.id||inventory.sessionId!==run.sessionId)throw new Error('query_inventory_owner');
    inventory.queryIds.forEach(id=>queryIds.add(id));originals.push(value);
  }
  return {queryIds:[...queryIds],originals};
}

export async function collectObservation(options: { executionId: string; trialId: string; product: ProductAdapter; aliases: AliasState; lastSendAlias?: string | null; trialRoot: string; observedFrom: string; pageSize?: number }): Promise<VerifiedObservation> {
  const { product, aliases, trialRoot } = options;
  const pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('observation_page_size_invalid');
  const facts: Record<string, unknown[]> = Object.fromEntries(['runs', 'modelCalls', 'toolCalls', 'queries', 'evidence', 'answers', 'artifacts', 'operations', 'inputs', 'contexts', 'events', 'history', 'controls', 'runPages', 'queryPages', 'evidencePages', 'identitySnapshots', 'activity', 'artifactFiles', 'sessions', 'checkpoints', 'intents', 'catalogPages', 'batches','resources','queryInventories'].map(key => [key, []]));
  const missing: VerifiedObservation['missing'] = [], identityChecks: VerifiedObservation['identityChecks'] = [];
  const check = (id: string, passed: boolean, reason: string) => { identityChecks.push({ id, passed, reason }); if (!passed) missing.push({ key: id, reason }); };
  async function read<M extends PublicMethod>(method: M, payload: PublicPayload<M>): Promise<PublicReturn<M> | undefined> {
    try { return unwrap(await product.request(method, payload)); }
    catch (error) { missing.push({ key: method, reason: error instanceof Error ? error.message : 'read_failed' }); return undefined; }
  }
  const seenRuns = new Set<number>(), seenContexts = new Set<string>(), queries = new Set(aliases.queries.values()), artifacts = new Set<number>();
  const toolDiscovery=new Map<number,boolean>(),childDiscovery=new Map<number,boolean>();
  const ownedSessions = new Set([...aliases.sessions.values()].map(session => session.id));
  const runQueue = [...new Set(aliases.runs.values())];
  const control = await read('run.control.read', {});
  if (control) { facts.controls!.push({ observedAt: new Date().toISOString(), ...control }); check('control.instance', control.instanceId === product.instanceId, 'Current control instance matches active Host'); }
  for (let page = 1; ; page++) {
    const catalog = await read('data.read', { page, pageSize }); if (!catalog) break;
    facts.catalogPages!.push(catalog); facts.batches!.push(...catalog.batches);
    check(`catalog.${page}`, catalog.page === page && catalog.pageSize === pageSize, 'Catalog page identity matches public request');
    if (page * catalog.pageSize >= catalog.batchCount) break;
    if (!catalog.batches.length) { missing.push({ key: 'catalog.pagination', reason: 'Empty nonterminal catalog page' }); break; }
  }
  for (const [alias, owner] of aliases.sessions) {
    const detail = await read('session.read', { sessionId: owner.id });
    if (detail) { facts.sessions!.push(detail); check(`session.${alias}`, detail.session.id === owner.id && detail.session.nativeSessionId === owner.nativeSessionId, 'Session/native identity matches accepted creation'); }
    try {
      const pages = await readAllMessages(product, owner.id); facts.history!.push(...pages);
      check(`history.${alias}`, pages.every(page => page.sessionId === owner.id && page.nativeSessionId === owner.nativeSessionId), 'History preserves Session, native identity, leaf and source');
      if (pages.some(page => page.items.some(item => item.textInfo.truncated || item.textInfo.redacted))) missing.push({ key: `history.${alias}.fullText`, reason: 'Public history is a bounded or redacted display projection' });
    } catch (error) { missing.push({ key: `history.${alias}`, reason: error instanceof Error ? error.message : 'history_read_failed' }); }
    try { facts.inputs!.push(...(await listAllInputs(product, owner.id)).flatMap(page => page.items)); }
    catch (error) { missing.push({ key: `inputs.${alias}`, reason: error instanceof Error ? error.message : 'input_read_failed' }); }
    let beforeRunId: number | undefined;
    const seen = new Set<number>();
    for (;;) {
      const page = await read('run.read', { recent: true, sessionId: owner.id, kind: 'agent', limit: 50, ...(beforeRunId ? { beforeRunId } : {}) });
      if (!page || page.kind !== 'recent') break;
      runQueue.push(...page.runs.map(run => run.id));
      if (page.nextBeforeRunId === null) break;
      if (seen.has(page.nextBeforeRunId)) { missing.push({ key: 'runs.pagination', reason: 'Repeated run cursor' }); break; }
      seen.add(page.nextBeforeRunId); beforeRunId = page.nextBeforeRunId;
    }
    let afterAnswerId: number | null = null; const checkpointCursors = new Set<number>();
    for (;;) {
      const page: SessionCheckpointPage | undefined = await read('session.checkpoints.read', { sessionId: owner.id, afterAnswerId, limit: 100 }); if (!page) break;
      facts.checkpoints!.push(...page.items.map(item => ({ sessionId: owner.id, ...item })));
      if (page.nextAnswerId === null) break;
      if (checkpointCursors.has(page.nextAnswerId)) { missing.push({ key: 'checkpoints.pagination', reason: 'Repeated checkpoint cursor' }); break; }
      checkpointCursors.add(page.nextAnswerId); afterAnswerId = page.nextAnswerId;
    }
    let beforeEventId: number | undefined; const activityCursors = new Set<number>();
    for (;;) {
      const page = await read('activity.list', { sessionId: owner.id, limit: 100, ...(beforeEventId ? { beforeEventId } : {}) }); if (!page) break;
      facts.activity!.push(...page.items);
      check(`activity.${alias}.${beforeEventId ?? 0}`, page.items.every(item => item.sessionId === owner.id), 'Activity belongs to original Session');
      if (page.nextBeforeEventId === null) break;
      if (activityCursors.has(page.nextBeforeEventId)) { missing.push({ key: 'activity.pagination', reason: 'Repeated activity cursor' }); break; }
      activityCursors.add(page.nextBeforeEventId); beforeEventId = page.nextBeforeEventId;
    }
  }
  for (const runId of runQueue) {
    if (seenRuns.has(runId)) continue; seenRuns.add(runId);
    let inputOffset = 0, outputOffset = 0, callOffset = 0; const cursors = new Set<string>(); let first = true;
    for (;;) {
      const page = await read('run.read', { runId, inputOffset, outputOffset, callOffset, inputLimit: 65536, outputLimit: 32768, callLimit: 50 });
      if (!page || page.kind !== 'one' || !page.run) { missing.push({ key: `run.${runId}`, reason: 'Original run not returned' }); break; }
      const run = page.run; facts.runPages!.push(run);
      check(`run.${runId}.owner`, run.id === runId && product.instanceIds.includes(run.instanceId) && (run.sessionId === null || ownedSessions.has(run.sessionId) || run.kind === 'child'), 'Run id, original Host and Session ownership checked');
      check(`run.${runId}.time`, run.createdAt >= options.observedFrom && run.createdAt <= new Date().toISOString(), 'Run creation lies within this Trial observation window');
      if (first) {
        facts.runs!.push(run); first = false;
        const answer = run.kind === 'agent' ? await read('answer.read', { runId }) : null;
        if (answer) { facts.answers!.push(answer); check(`answer.${answer.id}.owner`, answer.runId === runId && answer.sessionId === run.sessionId, 'Answer belongs to original Run and Session'); answer.queryIds.forEach(id => queries.add(id)); }
        if (run.kind === 'agent') {
          childDiscovery.set(runId,false);
          const intent = await read('intent.read', { runId }); if (intent) { const original=IntentReadResultSchema.parse(intent);facts.intents!.push({...original,protocolValidated:true}); check(`intent.${runId}`, intent.runId === runId && intent.sessionId === run.sessionId, 'Intent facts belong to original Run and Session'); }
          let beforeRunId: number | undefined; const childCursors = new Set<number>();
          for (;;) {
            const children = await read('run.read', { recent: true, parentRunId: runId, limit: 50, ...(beforeRunId ? { beforeRunId } : {}) });
            if (!children || children.kind !== 'recent') break;
            for (const child of children.runs) { if (child.kind !== 'child' || child.parentRunId !== runId) { check(`child.${child.id}.parent`, false, 'Child parent mismatch'); continue; } runQueue.push(child.id); if (child.sessionId !== null) ownedSessions.add(child.sessionId); }
            if (children.nextBeforeRunId === null) {childDiscovery.set(runId,true);break;}
            if (childCursors.has(children.nextBeforeRunId)) { missing.push({ key: `run.${runId}.children`, reason: 'Repeated child cursor' }); break; }
            childCursors.add(children.nextBeforeRunId); beforeRunId = children.nextBeforeRunId;
          }
        }
      }
      facts.modelCalls!.push(...run.calls.filter(call => !facts.modelCalls!.some(existing => (existing as { callId: string }).callId === call.callId))
        .map(call => ({ ...call, runId, sessionId: run.sessionId, instanceId: run.instanceId })));
      for (const call of run.calls) {
        if (seenContexts.has(call.callId)) continue; seenContexts.add(call.callId);
        const context = await read('context.read', { callId: call.callId });
        if (context) { facts.contexts!.push(context); check(`context.${call.callId}`, context.kind !== 'snapshot' || context.snapshot.runId === runId && context.snapshot.sessionId === run.sessionId, 'Context belongs to original Run/Session'); }
      }
      const nextInput = run.inputPage.nextOffset, nextOutput = run.output.nextOffset, nextCall = 'nextCallOffset' in run ? run.nextCallOffset : null;
      if (nextInput === null && nextOutput === null && nextCall === null) break;
      const key = `${nextInput}:${nextOutput}:${nextCall}`;
      if (cursors.has(key)) { missing.push({ key: `run.${runId}.pagination`, reason: 'Repeated run page cursor' }); break; }
      cursors.add(key); inputOffset = nextInput ?? inputOffset; outputOffset = nextOutput ?? outputOffset; callOffset = nextCall ?? callOffset;
    }
    const resourceList=await read('resources.list',{source:'run',runId});
    if(resourceList){
      check(`resources.${runId}.owner`,resourceList.source==='run'&&resourceList.runId===runId,'Recorded resources belong to the original run');
      for(const resource of resourceList.items.filter(item=>item.enabled&&item.availability==='ready'))for(const file of resource.files){
        const text=await read('resources.read',{source:'run',runId,resourceRef:resource.ref,file:file.file});
        if(text){const valid=text.source==='run'&&text.runId===runId&&text.resourceRef.kind===resource.ref.kind&&text.resourceRef.id===resource.ref.id&&text.resourceRef.version===resource.ref.version&&text.resourceRef.treeHash===resource.ref.treeHash&&text.sha256===file.sha256&&hashBytes(Buffer.from(text.content))===text.sha256&&text.file===file.file&&Buffer.byteLength(text.content)===text.bytes;check(`resource.${runId}.${resource.ref.id}.${file.file}`,valid,'Original resource identity and content bytes checked');if(valid)facts.resources!.push({runId,kind:resource.ref.kind,id:resource.ref.id,version:resource.ref.version,file:file.file,content:text.content,bytes:text.bytes,protocolValidated:true});}
      }
    }
    toolDiscovery.set(runId,false);
    for (let page = 1; ; page++) {
      const tools = await read('tool.read', { runId, page, pageSize: Math.min(pageSize,TOOL_READ_RULES.maxPageSize) }); if (!tools) break;
      facts.toolCalls!.push(...tools.items);
      check(`tool.${runId}.${page}`, tools.runId === runId && tools.items.every(tool => tool.runId === runId && ownedSessions.has(tool.sessionId)), 'Tool originals belong to Run/Session');
      if (page * tools.pageSize >= tools.totalRows) {toolDiscovery.set(runId,(facts.toolCalls! as {runId:number;id:number}[]).filter(tool=>tool.runId===runId).length===tools.totalRows);break;}
      if (!tools.items.length) { missing.push({ key: `tool.${runId}.pagination`, reason: 'Empty nonterminal tool page' }); break; }
    }
    let afterSequence = 0, throughSequence: number | null = null;
    for (;;) {
      const page: EventPage | undefined = await read('event.read', { runId, afterSequence, throughSequence, limit: 100 }); if (!page) break;
      if (throughSequence === null) throughSequence = page.range.lastSequence;
      facts.events!.push(...page.events);
      check(`events.${runId}.${afterSequence}`, page.runId === runId && page.events.every(event => event.runId === runId), 'Event owner matches original Run');
      if (!page.hasMore) break;
      if (page.nextSequence <= afterSequence) { missing.push({ key: `events.${runId}.pagination`, reason: 'Event cursor did not advance' }); break; } afterSequence = page.nextSequence;
    }
  }
  for (const operation of aliases.operations.values()) {
    if (operation.kind === 'compaction') {
      if (operation.sessionId === undefined) { missing.push({ key: `compaction.${operation.operationRef}`, reason: 'Compaction Session identity missing' }); continue; }
      const value = await read('session.compaction.read', { sessionId: operation.sessionId, operationRef: operation.operationRef });
      if (value) {
        facts.operations!.push({ kind: 'compaction', ...value }); check(`compaction.${operation.operationRef}`, value.operationRef === operation.operationRef && value.sessionId === operation.sessionId, 'Manual compaction is a non-Run operation');
        facts.modelCalls!.push(...value.calls.map(call => ({ ...call, runId: value.receipt?.runId ?? null, sessionId: value.sessionId, operationRef: value.operationRef, instanceId: null })));
      } else if (value === null) missing.push({ key: `compaction.${operation.operationRef}`, reason: 'Original compaction operation is not recorded' });
      continue;
    }
    const value = await read('evidence.readOperation', { kind: operation.kind, operationRef: operation.operationRef });
    if (value) { facts.operations!.push({ kind: operation.kind, ...value }); check(`operation.${operation.operationRef}`, value.operationRef === operation.operationRef, 'Original operation identity preserved');
      if ('artifactId' in value && value.artifactId !== null) artifacts.add(value.artifactId);
      if ('artifact' in value && value.artifact !== null) artifacts.add(value.artifact.id);
    } else if (value === null) missing.push({ key: `operation.${operation.operationRef}`, reason: 'Original operation is not recorded' });
  }
  let queryInventoryComplete=false;
  try{const inventory=await readQueryInventory(product,facts.runs! as {id:number;sessionId:number|null;instanceId:string}[]);inventory.queryIds.forEach(id=>queries.add(id));facts.queryInventories!.push(...inventory.originals);queryInventoryComplete=true;}
  catch(error){missing.push({key:'queryInventory',reason:error instanceof Error?error.message:'query_inventory_failed'});}
  for (const queryId of queries) {
    for (let page = 1; ; page++) {
      const value = await read('query.read', { queryId, page, pageSize }); if (!value) {queryInventoryComplete=false;break;}
      facts.queryPages!.push(value); if (page === 1) facts.queries!.push(value.query);
      check(`query.${queryId}.${page}`, value.query.id === queryId && value.page.queryId === queryId && ownedSessions.has(value.query.sessionId), 'Query owner and page identity match');
      if (page === 1) for (const summary of value.evidence) {
        facts.evidence!.push(summary);
        for (let evidencePage = 1; ; evidencePage++) {
          const evidence = await read('evidence.read', { queryId, evidenceId: summary.id, page: evidencePage, pageSize }); if (!evidence) break;
          facts.evidencePages!.push(evidence); check(`evidence.${summary.id}.${evidencePage}`, evidence.evidence.id === summary.id && evidence.evidence.queryId === queryId, 'Evidence belongs to original Query');
          if (evidencePage * evidence.pageSize >= evidence.totalRows) break;
          if (!evidence.items.length) { missing.push({ key: `evidence.${summary.id}.pagination`, reason: 'Empty nonterminal evidence page' }); break; }
        }
      }
      if (page * value.page.pageSize >= value.page.totalRows) break;
      if (!value.page.rows.length) { queryInventoryComplete=false;missing.push({ key: `query.${queryId}.pagination`, reason: 'Empty nonterminal Query page' }); break; }
    }
  }
  // Empty filtered results still need an independently observed numeric Device identity.
  const identityIds = new Set((facts.queries! as any[]).flatMap(query => query.params.deviceIds ?? []));
  for (const page of facts.evidencePages! as any[]) for (const snapshot of page.items) identityIds.delete(snapshot.deviceId);
  const identityBatches = new Set((facts.queries! as any[]).flatMap(query => query.params.batchIds));
  for (const batchId of identityBatches) {
    if (!identityIds.size) break;
    for (let page = 1; identityIds.size; page++) {
      const rows = await read('data.rows', { batchId, kind: 'devices', page, pageSize }); if (!rows || rows.kind !== 'devices') break;
      const valid = rows.page === page && rows.pageSize === pageSize && rows.items.every(row => row.batchId === batchId);
      check(`device.identity.${batchId}.${page}`, valid, 'Catalog snapshots preserve requested batch and page identity');
      if (!valid) break;
      for (const row of rows.items) if (identityIds.delete(row.deviceId)) facts.identitySnapshots!.push(row);
      if (page * rows.pageSize >= rows.totalRows || !rows.items.length) break;
    }
  }
  for (const artifactId of artifacts) {
    const artifact = await read('evidence.readArtifact', { artifactId }); if (!artifact) { missing.push({ key: `artifact.${artifactId}`, reason: 'Registered artifact is missing' }); continue; }
    facts.artifacts!.push(artifact); check(`artifact.${artifactId}`, artifact.id === artifactId, 'Registered Artifact identity matches operation');
    if ('status' in artifact && artifact.status !== 'ready') continue;
    try {
      const files = await copyEvidenceTree(join(product.paths.dataRoot, 'artifacts', String(artifactId)), join(trialRoot, 'artifacts', String(artifactId)));
      await verifyCopiedArtifact(artifact, files);
      await archiveArtifactFiles(files);(artifact as any).protocolValidated=true;
      facts.artifactFiles!.push(...files.map(file => ({ artifactId, ...file,evidencePath:'artifacts/'+artifactId+'/'+file.relativePath })));
    } catch (error) { missing.push({ key: `artifact.${artifactId}.files`, reason: error instanceof Error ? error.message : 'artifact_copy_failed' }); }
  }
  facts.providerRequests=[];facts.nativeHistory=[];facts.toolOriginals=[];facts.runOriginals=[];
  const capture=async(key:string,selector:Parameters<typeof readControllerOriginal>[1])=>{
    try{const owner=(facts.runs!.find((run:any)=>run.id===selector.runId) as {instanceId?:string}|undefined)?.instanceId??product.instanceId;const original=await readControllerOriginal(product,selector,owner);facts[key]!.push(original);check(`${key}.${JSON.stringify(selector)}`,true,'Complete identity-bound product original verified before archive projection');
      if(selector.kind==='history')for(const [alias,session] of aliases.sessions)if(session.id===selector.sessionId) {
        const index=missing.findIndex(item=>item.key===`history.${alias}.fullText`);if(index>=0)missing.splice(index,1);
      }
    }
    catch(error){missing.push({key,reason:error instanceof Error?error.message:'controller_original_read_failed'});}
  };
  for(const call of facts.modelCalls!) {
    const item=call as {callId:string;sessionId:number|null;runId:number|null;kind:string};
    if(item.kind!=='intent')await capture('providerRequests',{kind:'request',callId:item.callId,sessionId:item.sessionId,runId:item.runId});
  }
  for(const sessionId of ownedSessions) {
    const run=facts.runs!.find((value:any)=>value.sessionId===sessionId) as {id:number}|undefined;
    if(run)await capture('nativeHistory',{kind:'history',sessionId,runId:run.id});
  }
  for(const tool of facts.toolCalls! as {id:number;runId:number;sessionId:number}[])await capture('toolOriginals',{kind:'tool',runId:tool.runId,sessionId:tool.sessionId,toolCallId:tool.id});
  for(const run of facts.runs! as {id:number;sessionId:number|null}[])if(run.sessionId!==null)await capture('runOriginals',{kind:'run',runId:run.id,sessionId:run.sessionId});
  const body = { executionId: options.executionId, trialId: options.trialId, instanceId: product.instanceId, observedFrom: options.observedFrom,
    observedUntil: new Date().toISOString(), identityChecks, facts: { ...facts, collectionCompleteness:{tools:[...seenRuns].every(id=>toolDiscovery.get(id)===true),children:(facts.runs! as {id:number;kind:string}[]).filter(run=>run.kind==='agent').every(run=>childDiscovery.get(run.id)===true),queries:queryInventoryComplete}, aliases: {
      source: 'controller-accepted-public-identities', lastSendAlias: options.lastSendAlias ?? null,
      runs: [...aliases.runs].map(([alias, runId]) => ({ alias, runId })), queries: [...aliases.queries].map(([alias, queryId]) => ({ alias, queryId })),
      sessions: [...aliases.sessions].map(([alias, session]) => ({ alias, sessionId: session.id })),
      inputs:[...aliases.inputs].map(([alias,input])=>({alias,...input})),
      batches: [...aliases.batches].map(([alias, batchId]) => ({ alias, batchId })),
      operations: [...aliases.operations].map(([alias, operation]) => ({ alias, ...operation })),
    } }, missing };
  const observation = projectPublicEvidence(body);
  await writeFile(join(trialRoot, 'observation.json'), JSON.stringify(observation, null, 2), { mode: 0o600 });
  Object.defineProperty(observation.facts,'evidenceRoot',{value:trialRoot,enumerable:false});
  await product.flush(); return observation;
}
