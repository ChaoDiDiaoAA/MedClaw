import { readFile } from 'node:fs/promises';
import {resolve} from 'node:path';
import { z } from 'zod';
import { QueryViewSchema as ProductQueryViewSchema, EvidenceViewSchema as ProductEvidenceViewSchema, QuerySummarySchema, EvidenceSummarySchema, SnapshotSchema, BatchSchema, SourceRefSchema, DesktopQueryPageSchema, AnswerRecordSchema, QueryParamsSchema } from '../../../packages/contracts/src/query.ts';
import { DataCatalogSchema } from '../../../packages/contracts/src/data.ts';
import { ExportArtifactSchema, ExportOperationSchema } from '../../../packages/contracts/src/export.ts';
import { readCsvRecords } from '../../../packages/core/src/data/import-service.ts';
import { verifyCopiedArtifact, type CopiedFile } from '../adapters/files.ts';
import { equal, record } from './rules.ts';
import type { CheckSpec, EvaluationContext } from './types.ts';
import { projectIntent } from './project-intent.ts';
import { projectHarness,verifiedOriginals,toolCollectionHasGaps } from './project-harness.ts';
import { projectPublicEvidence } from '../data-format.ts';

const PublicSnapshotSchema=SnapshotSchema.extend({sourceRefs:z.array(SourceRefSchema.omit({sha256:true}))});
const PublicCatalogSchema=DataCatalogSchema.extend({batches:z.array(BatchSchema.omit({sourceLockHash:true,contentHash:true,cohortHash:true}))});
type Snapshot=z.infer<typeof PublicSnapshotSchema>;
const PublicEvidenceSummarySchema=EvidenceSummarySchema.omit({sourceLockHash:true,resultHash:true});
const QueryViewSchema=ProductQueryViewSchema.extend({query:QuerySummarySchema.omit({resultHash:true}),page:z.strictObject(DesktopQueryPageSchema.shape).omit({targetVersion:true}).refine(page=>page.rowKeys.length===page.rows.length),evidence:z.array(PublicEvidenceSummarySchema)});
const EvidenceViewSchema=z.strictObject(ProductEvidenceViewSchema.shape).omit({targetVersion:true}).extend({evidence:PublicEvidenceSummarySchema,items:z.array(PublicSnapshotSchema)}).refine(page=>page.rowKeys.length===page.items.length&&page.rowKeys.every(key=>key===null||key.startsWith('snapshot:')));
const PublicExportArtifact=z.strictObject(ExportArtifactSchema.shape).omit({sha256:true,metadataSha256:true}).extend({protocolValidated:z.literal(true)});
const PublicExportOperation=z.strictObject(ExportOperationSchema.shape).omit({requestHash:true,publishedHash:true}).extend({artifact:PublicExportArtifact.nullable()});

type QueryView = ReturnType<typeof QueryViewSchema.parse>;
type EvidenceView = ReturnType<typeof EvidenceViewSchema.parse>;
interface CompleteQuery { query: QueryView['query']; rows: QueryView['page']['rows']; pages: QueryView[]; evidence: EvidenceView[] }
export interface ObservationProjection { actual?: unknown; expected?:unknown; evidenceRefs: string[]; reason?: string }
const gap = (reason: string): ObservationProjection => ({ evidenceRefs: [], reason });
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const artifactFiles=(facts:Record<string,unknown>)=>list(facts.artifactFiles).map(file=>({...file,evidencePath:typeof facts.evidenceRoot==='string'?resolve(facts.evidenceRoot,file.evidencePath):file.evidencePath}));

function completeQueries(facts: Record<string, unknown>): Map<number, CompleteQuery> | undefined {
  if (!Array.isArray(facts.queryPages)) return undefined;
  const groups = new Map<number, QueryView[]>();
  for (const raw of facts.queryPages) {
    const parsed = QueryViewSchema.safeParse(projectPublicEvidence(raw)); if (!parsed.success) return undefined;
    const view = parsed.data;
    if (view.query.id !== view.page.queryId || view.query.totalRows !== view.page.totalRows) return undefined;
    const pages = groups.get(view.query.id) ?? []; pages.push(view); groups.set(view.query.id, pages);
  }
  const result = new Map<number, CompleteQuery>();
  for (const [id, pages] of groups) {
    pages.sort((a, b) => a.page.page - b.page.page);
    const first = pages[0]!, { totalRows, pageSize } = first.page;
    if (pages.length !== Math.max(1, Math.ceil(totalRows / pageSize)) || pages.some((p, index) => p.page.page !== index + 1 || p.page.pageSize !== pageSize || !equal(p.query, first.query) || !equal(p.evidence, first.evidence) || p.page.rows.length !== Math.min(pageSize, Math.max(0, totalRows - index * pageSize)))) return undefined;
    const rows = pages.flatMap(p => p.page.rows);
    result.set(id, { query: first.query, rows, pages, evidence: [] });
  }
  return result;
}
function attachEvidence(facts: Record<string, unknown>, queries: CompleteQuery[]): boolean {
  const pages = list(facts.evidencePages);
  for (const query of queries) for (const summary of query.pages[0]!.evidence) {
    const matching = pages.filter(p => record(p) && record(p.evidence) && p.evidence.id === summary.id);
    const parsed = matching.map(p => EvidenceViewSchema.safeParse(projectPublicEvidence(p)));
    if (!parsed.length || parsed.some(p => !p.success)) return false;
    const views = parsed.flatMap(p => p.success ? [p.data] : []).sort((a, b) => a.page - b.page), first = views[0]!;
    if (views.length !== Math.max(1, Math.ceil(first.totalRows / first.pageSize)) || views.some((v, index) => v.page !== index + 1 || v.pageSize !== first.pageSize || v.totalRows !== first.totalRows || v.evidence.queryId !== query.query.id || !equal(v.evidence, summary) || v.items.length !== Math.min(first.pageSize, Math.max(0, first.totalRows - index * first.pageSize))) || first.totalRows !== summary.snapshotCount) return false;
    query.evidence.push(...views);
  }
  return true;
}
function selectQueries(check: CheckSpec, context: EvaluationContext, all: Map<number, CompleteQuery>): CompleteQuery[] | undefined {
  const facts = context.observation!.facts, values = record(context.gold.values) ? context.gold.values : {};
  const selection = record(values.querySelection) && record(values.querySelection[check.evidenceKey]) ? values.querySelection[check.evidenceKey] : undefined;
  const aliases = record(facts.aliases) ? facts.aliases : undefined;
  const suffix = check.evidenceKey.split('__')[1];
  const alias = selection?.runAlias ?? (check.scope?.kind==='run'?check.scope.ref:undefined) ?? (suffix ? suffix.replaceAll('_', '-') : values.finalStageAlias ?? aliases?.lastSendAlias);
  if (typeof alias !== 'string' || !aliases || !Array.isArray(aliases.runs)) return undefined;
  const bindings = aliases.runs.filter(x => record(x) && x.alias === alias && Number.isSafeInteger(x.runId));
  if (bindings.length !== 1) return undefined;
  let selected = [...all.values()].filter(x => x.query.runId === bindings[0].runId).sort((a, b) => a.query.id - b.query.id);
  if (selection?.queryIndex !== undefined) {
    if (!Number.isSafeInteger(selection.queryIndex) || selection.queryIndex < 1 || selection.queryIndex > selected.length) return undefined;
    selected = [selected[selection.queryIndex - 1]!];
  }
  return selected.length ? selected : undefined;
}

/** Rebind numeric product Device IDs only through registered, verified import rows. */
export async function sourceIdentities(facts: Record<string, unknown>, snapshots: Snapshot[]): Promise<Map<number, string> | undefined> {
  const result = new Map<number, string>(), artifacts = list(facts.artifacts), files = artifactFiles(facts), operations = list(facts.operations), batches = list(facts.batches);
  const verified = new Set<number>(), csv = new Map<string, string[][]>();
  const supplemental = list(facts.identitySnapshots).map(row => PublicSnapshotSchema.safeParse(row));
  if (supplemental.some(row => !row.success)) return undefined;
  for (const snapshot of [...snapshots, ...supplemental.flatMap(row => row.success ? [row.data] : [])]) {
    const batch = batches.find(b => record(b) && b.id === snapshot.batchId);
    if (!batch || typeof batch.sourceBundleId !== 'string') return undefined;
    const separator = snapshot.sourceRowRef.lastIndexOf(':'), name = snapshot.sourceRowRef.slice(0, separator), line = Number(snapshot.sourceRowRef.slice(separator + 1));
    if (separator < 1 || !Number.isSafeInteger(line) || line < 2 || name.includes('..') || name.startsWith('/') || name.includes('\\')) return undefined;
    const candidates = operations.filter(op => record(op) && op.kind === 'import' && record(op.result) && Array.isArray(op.result.batchIds) && op.result.batchIds.includes(snapshot.batchId) && op.result.sourceBundleId === batch.sourceBundleId && Number.isSafeInteger(op.artifactId));
    if (candidates.length !== 1) return undefined;
    const artifactId = candidates[0].artifactId, artifact = artifacts.find(a => record(a) && a.id === artifactId && a.status === 'ready');
    const artifactFiles = files.filter(f => record(f) && f.artifactId === artifactId) as (CopiedFile & { artifactId: number })[];
    if (!artifact) return undefined;
    if (!verified.has(artifactId)) { await verifyCopiedArtifact(artifact, artifactFiles); verified.add(artifactId); }
    const file = artifactFiles.find(f => f.relativePath === `input/${name}`);
    if (!file) return undefined;
    let rows = csv.get(file.evidencePath);
    if (!rows) { rows = [...readCsvRecords(file.evidencePath, undefined, file.sha256)]; csv.set(file.evidencePath, rows); }
    const headers = rows[0], row = rows[line - 1];
    if (!headers || !row || row.length !== headers.length) return undefined;
    const source = Object.fromEntries(headers.map((h, index) => [h, row[index]]));
    if (!source.device_id || source.device_name !== snapshot.deviceName || source.region !== snapshot.region || source.snapshot_date !== batch.snapshotDate || source.currency !== snapshot.currency || source.unit !== snapshot.unit || (source.price_cents === '' ? null : Number(source.price_cents)) !== snapshot.priceCents || !equal(JSON.parse(source.source_refs_json!), snapshot.sourceRefs)) return undefined;
    const previous = result.get(snapshot.deviceId); if (previous !== undefined && previous !== source.device_id) return undefined;
    result.set(snapshot.deviceId, source.device_id);
  }
  return result;
}
function parameters(query: CompleteQuery) {
  const original = query.query.params;
  return QueryParamsSchema.safeParse({ ...original, kind: query.query.kind, population: 'population' in original ? original.population : query.query.kind === 'changes' ? 'changes' : 'snapshot', snapshotMode: 'snapshotMode' in original ? original.snapshotMode : query.query.kind === 'changes' ? null : 'exact_date' });
}
export async function observedConditions(facts:Record<string,unknown>,raw:unknown) {
  const parsed=QueryParamsSchema.safeParse(raw);if(!parsed.success)return undefined;
  const p=parsed.data;
  let device:string|null=null;
  if(p.deviceIds) {
    const identities=await sourceIdentities(facts,list(facts.evidencePages).flatMap(page=>list(page.items)));
    if(p.deviceIds.length!==1||!identities?.has(p.deviceIds[0]!))return undefined;
    device=identities.get(p.deviceIds[0]!)!;
  }
  const point=p.kind==='current'||p.kind==='aggregate'&&p.population==='snapshot';
  return {region:p.region,regions:null,date:point?p.time?.start??null:null,start:point?null:p.time?.start??null,endExclusive:point?null:p.time?.endExclusive??null,sourceDeviceId:device,manufacturer:p.manufacturer,category:p.category,status:p.status,snapshotMode:p.snapshotMode,threshold:p.threshold?{operator:p.threshold.operator,percent:p.threshold.value*100}:null};
}
export async function sourceScope(facts:Record<string,unknown>,scope:{batchIds:number[];deviceIds:number[]|null}) {
  if(scope.deviceIds!==null) {
    const snapshots=list(facts.evidencePages).flatMap(page=>list(page.items)).filter(snapshot=>scope.batchIds.includes(snapshot.batchId)&&scope.deviceIds!.includes(snapshot.deviceId));
    const identities=await sourceIdentities(facts,snapshots);if(!identities||scope.deviceIds.some(id=>!identities.has(id)))return undefined;
    return [...new Set(snapshots.map(snapshot=>identities.get(snapshot.deviceId)+'@'+list(facts.batches).find(batch=>batch.id===snapshot.batchId)?.scopeKey))].sort();
  }
  const ids=new Set<string>();
  for(const batchId of scope.batchIds) {
    const batch=list(facts.batches).find(batch=>batch.id===batchId),operation=list(facts.operations).find(op=>op.kind==='import'&&op.result?.batchIds?.includes(batchId));
    if(!batch||!operation)return undefined;
    const artifact=list(facts.artifacts).find(artifact=>artifact.id===operation.artifactId),files=artifactFiles(facts).filter(file=>file.artifactId===operation.artifactId);
    if(!artifact)return undefined;await verifyCopiedArtifact(artifact,files);
    const source=files.find(file=>file.relativePath===`input/zhejiang_${batch.snapshotDate}.csv`);if(!source)return undefined;
    const rows=[...readCsvRecords(source.evidencePath,undefined,source.sha256)],headers=rows[0]??[];
    for(const row of rows.slice(1)) {
      const fields=Object.fromEntries(headers.map((header,index)=>[header,row[index]]));
      if(fields.snapshot_date===batch.snapshotDate&&fields.region===batch.region&&fields.device_id)ids.add(fields.device_id+'@'+batch.scopeKey);
    }
  }
  return [...ids].sort();
}

async function coverageEvidence(facts: Record<string, unknown>) {
  try {
    const parsed = list(facts.catalogPages).map(page => PublicCatalogSchema.safeParse(page));
    if (!parsed.length || parsed.some(page => !page.success)) return undefined;
    const pages = parsed.flatMap(page => page.success ? [page.data] : []).sort((a, b) => a.page - b.page), first = pages[0]!;
    if (pages.length !== Math.max(1, Math.ceil(first.batchCount / first.pageSize)) || pages.some((page, index) => page.page !== index + 1 || !equal({ ...page, batches: [], page: 0 }, { ...first, batches: [], page: 0 }) || page.batches.length !== Math.min(first.pageSize, Math.max(0, first.batchCount - index * first.pageSize)))) return undefined;
    const batches = pages.flatMap(page => page.batches), imports = list(facts.operations).filter(operation => operation.kind === 'import');
    if (!batches.length || new Set(batches.map(batch => batch.id)).size !== batches.length || !equal(batches, facts.batches)
      || imports.some(operation => !Array.isArray(operation.result?.batchIds) || operation.result.batchIds.some((id: number) => !batches.some(batch => batch.id === id)))) return undefined;
    for (const batch of batches) {
      const owners = imports.filter(operation => operation.result?.sourceBundleId === batch.sourceBundleId && operation.result.batchIds.includes(batch.id));
      if (owners.length !== 1 || (await sourceScope(facts, { batchIds: [batch.id], deviceIds: null }))?.length !== batch.observedEntityCount) return undefined;
    }
    return { batches, refs: [...pages.map(page => 'catalog:' + page.page), ...imports.map(operation => 'artifact:' + operation.artifactId)],
      sources: list(facts.artifactFiles).filter(file => imports.some(operation => operation.artifactId === file.artifactId)).map(file => ({ artifactId: file.artifactId, path: file.relativePath, content: file.content })) };
  } catch { return undefined; }
}
function independentSources(sources:{path:string;content:string;artifactId:number}[]) {
  const origins:{id:string;kind:string}[]=[];
  for(const file of sources.filter(source=>source.path==='input/source-lock.json')) {
    const lock=JSON.parse(file.content);
    if(!Array.isArray(lock.sources))throw new Error('Original source lock has no sources');
    for(const source of lock.sources) {
      if(typeof source.source!=='string'||typeof source.origin!=='string')throw new Error('Original source identity is missing');
      origins.push({id:source.source,kind:source.origin==='synthetic'?'synthetic_authored':source.origin});
    }
  }
  return [...new Map(origins.map(source=>[source.id,source])).values()];
}

/** Project only public business/answer facts. Gold selects authored scope; it never supplies actual values. */
export async function projectObservation(check: CheckSpec, context: EvaluationContext): Promise<ObservationProjection | undefined> {
  const facts = context.observation?.facts;
  const checksCoverage = context.task.checks.some(item => item.metricId === 'query.coverage');
  if (facts && check.metricId === 'query.coverage') {
    const expected = (context.gold.values as any)?.[check.evidenceKey], evidence = await coverageEvidence(facts);
    if (!record(expected) || typeof expected.region !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expected.requestedDate) || !evidence) return gap('Complete catalog and registered import contents required for coverage');
    const batches = evidence.batches.filter(batch => batch.region === expected.region);
    return batches.length ? { actual: { region: expected.region, requestedDate: expected.requestedDate, complete: batches.some(batch => batch.snapshotDate === expected.requestedDate) }, evidenceRefs: evidence.refs } : gap('Requested region has no verified source coverage');
  }
  if(facts&&['tool.selection','efficiency.calls','evidence.present'].includes(check.metricId)&&!(check.metricId==='tool.selection'&&record((context.gold.values as any)?.[check.evidenceKey])&&Array.isArray((context.gold.values as any)[check.evidenceKey].opportunities))) {
    const rawTools=list(facts.toolCalls),tools=[...new Map(rawTools.map(tool=>[tool.id,tool])).values()],originals=verifiedOriginals(facts,'toolOriginals'),queries=list(facts.queries),refs=[...tools.map(tool=>'tool:'+tool.id),...queries.map(query=>'query:'+query.id)];
    const complete=!toolCollectionHasGaps(context)&&Array.isArray(facts.toolCalls)&&Array.isArray(facts.queries)&&rawTools.every(tool=>originals.some(original=>original.selector.toolCallId===tool.id&&equal(original.original,tool)))&&originals.every(original=>tools.some(tool=>tool.id===original.selector.toolCallId));
    if(check.metricId==='tool.selection')return {actual:{capabilities:[...new Set([...tools.map(tool=>tool.name),...(tools.some(tool=>/^query_(?:current|changes|device_changes|aggregate|trend|intent_step)/.test(tool.name))?['query']:[]),...(tools.some(tool=>tool.name==='Agent')?['delegate']:[])])],coverageComplete:complete},evidenceRefs:refs};
    if(check.metricId==='efficiency.calls')return complete?{actual:{calls:tools.map(tool=>({id:String(tool.id),kind:tool.name}))},evidenceRefs:refs}:gap('Complete native tool call records, SDK attempt identities and child inventory required for budget');
    const expected=(context.gold.values as any)?.[check.evidenceKey],needsSources=record(expected)&&(expected.expectedSources?.length||expected.minSources!==undefined||expected.sourceKinds?.length);
    if(!queries.length&&record(expected)&&expected.minSources===0&&!expected.expectedSources?.length) {
      const runs=list(facts.runs).filter(run=>run.kind!=='intent'),originals=verifiedOriginals(facts,'runOriginals');
      if(!runs.length||runs.some(run=>!originals.some(original=>original.selector.runId===run.id&&original.selector.sessionId===run.sessionId)||typeof run.stoppedAt!=='string'||!['completed','failed','cancelled'].includes(run.status)||!['stopConfirmed','requiredPersistenceComplete','inputsSettled','resourcesReleased'].every(key=>typeof run.cleanup?.[key]==='boolean')))return gap('Actual terminal Run identities and full lifecycle receipts required');
      const stopped=runs.every(run=>['stopConfirmed','requiredPersistenceComplete','inputsSettled','resourcesReleased'].every(key=>run.cleanup[key]===true)),refs=runs.flatMap(run=>[`run:${run.id}:stop`,`run:${run.id}:cleanup`]);
      return {actual:{complete:true,refs:stopped?refs:[],sources:[]},evidenceRefs:refs};
    }
    if (checksCoverage && !queries.length) {
      const evidence = await coverageEvidence(facts);
      return evidence ? { actual: { complete: true, refs: evidence.refs,...needsSources?{sources:independentSources(evidence.sources)}:{} }, evidenceRefs: evidence.refs } : gap('Missing-date claims require complete verified source coverage');
    }
    const all=completeQueries(facts);if(!all)return gap('Original query pages missing');
    const selected=selectQueries(check,context,all);if(!selected||!attachEvidence(facts,selected))return gap('Query and source evidence required, including legal empty queries');
    let sources:{id:string;kind:string}[]|undefined;
    if(needsSources) {
      const evidence=await coverageEvidence(facts);if(!evidence)return gap('Complete verified source materials required for source identity and independence');
      const selectedBatches=new Set(selected.flatMap(query=>query.query.batchIds)),owners=list(facts.operations).filter(operation=>operation.kind==='import'&&list(operation.result?.batchIds).some(id=>selectedBatches.has(id)));
      sources=independentSources(evidence.sources.filter(source=>owners.some(owner=>owner.artifactId===source.artifactId)));
      const resources=list(facts.resources),required=resources.map(resource=>({id:`${resource.kind}:${resource.id}@${resource.version}/${resource.file}`,content:resource.content}));
      if(required.length) {
        const projected=await projectHarness({...check,metricId:'resource.read',evidenceKey:'source_resources'},{...context,gold:{...context.gold,values:{...(context.gold.values as object),source_resources:{required}}}});
        const reads=record(projected?.actual)?list(projected.actual.opportunities).flatMap(opportunity=>list(opportunity.actual?.reads)):[];
        sources.push(...reads.map(read=>({id:String(read.id).slice(0,String(read.id).indexOf('/')),kind:'product_resource'})));
      }
    }
    return {actual:{complete:true,refs:selected.flatMap(query=>['query:'+query.query.id,...query.evidence.map(page=>'evidence:'+page.evidence.id)]),...sources?{sources}:{}},evidenceRefs:refs};
  }
  if(facts&&check.metricId.startsWith('intent.'))return projectIntent(check,context);
  if(facts&&check.kind!=='llm-judge'){const harness=await projectHarness(check,context);if(harness)return harness;}
  if (!facts || check.kind!=='llm-judge'&&!['query.conditions', 'query.facts', 'query.set_precision', 'query.set_recall', 'query.set_exact', 'query.numeric', 'query.aggregate', 'query.trend', 'diff.exact', 'export.exact', 'answer.faithful', 'answer.reasoning','answer.clarify'].includes(check.metricId)) return undefined;
  try {
    const all = completeQueries(facts); if (!all) return gap('Original Query records are malformed, crossed, or incompletely paginated');
    if (check.kind === 'llm-judge') {
      const authored=record(context.gold.values)?context.gold.values[check.evidenceKey]:undefined,aliases=record(facts.aliases)?facts.aliases:{};
      let selectedSource:Record<string,unknown>|undefined;
      if(record(authored)&&(authored.sourceTurnAlias!==undefined||authored.sessionAlias!==undefined)) {
        const sessions=authored.sessionAlias===undefined?[]:list(aliases.sessions).filter(binding=>binding.alias===authored.sessionAlias);
        if(authored.sessionAlias!==undefined&&sessions.length!==1)return gap('Authored Session alias has no unique actual identity');
        const bindings=list(aliases.inputs).filter(binding=>binding.alias===authored.sourceTurnAlias),binding=bindings[0];
        const inputs=bindings.length===1?list(facts.inputs).filter(input=>input.id===binding.inputId&&input.sessionId===binding.sessionId):[];
        if(inputs.length!==1||inputs[0].status!=='consumed'||!inputs[0].nativeEntryId||inputs[0].textInfo?.truncated===true||sessions.length&&inputs[0].sessionId!==sessions[0].sessionId)return gap('Authored source turn is not a complete consumed input in the selected Session');
        const input=inputs[0],history=verifiedOriginals(facts,'nativeHistory').find(original=>original.selector.sessionId===input.sessionId);
        const paths=list(facts.modelCalls).filter(call=>call.kind!=='intent'&&call.sessionId===input.sessionId).map(call=>{
          const entries=list(history?.original.entries),boundary=call.context?.nativeHistory,seen=new Set<string>(),path:string[]=[];let leaf=boundary?.leafId??boundary?.baseLeafId;
          while(typeof leaf==='string'&&!seen.has(leaf)){seen.add(leaf);const entry=entries.find(item=>item.id===leaf);if(!entry)break;path.push(entry.id);leaf=entry.parentId;}
          return {callId:call.callId,runId:call.runId,leafId:boundary?.leafId??boundary?.baseLeafId,path,sourceOnBranch:path.includes(input.nativeEntryId)};
        });
        if((check.metricId.startsWith('memory.')||check.metricId.startsWith('compaction.'))&&(!history||!list(history.original.entries).some(entry=>entry.id===input.nativeEntryId)))return gap('Native history does not contain the authored source input identity');
        selectedSource={sourceTurnAlias:authored.sourceTurnAlias,sessionAlias:authored.sessionAlias,input,requestBranches:paths};
      }
      const needed=check.metricId.startsWith('memory.')?['nativeHistory']:check.metricId.startsWith('compaction.')?['nativeHistory','operations']:check.metricId.startsWith('subagent.')?['runOriginals','toolOriginals']:[];
      if(needed.some(key=>!list(facts[key]).length))return gap('Actual native history, compaction or child evidence missing for semantic assessment');
      if(check.metricId.startsWith('compaction.')&&!list(facts.nativeHistory).some(item=>list(item.original?.entries).some(entry=>entry.type==='compaction')))return gap('No actual persisted compaction entry');
      if(check.metricId.startsWith('subagent.')&&!list(facts.runs).some(run=>run.kind==='child'))return gap('No actual child execution');
      const runId=check.scope?.kind==='run'?list(record(facts.aliases)?facts.aliases.runs:[]).find(binding=>binding.alias===check.scope!.ref)?.runId:undefined;
      if(check.scope?.kind==='run'&&!Number.isSafeInteger(runId))return gap('Semantic answer scope is not bound to an actual run');
      const answers = list(facts.answers).filter(answer=>runId===undefined||answer.runId===runId).map(a => AnswerRecordSchema.safeParse(a));
      if (!answers.length || answers.some(a => !a.success)) return gap('Original complete Answer records are unavailable');
      const originals = answers.flatMap(a => a.success ? [a.data] : []);
      const referenced = originals.flatMap(a => a.queryIds);
      if (referenced.some(id => !all.has(id))) return gap('Answer references a missing original Query');
      const queries = [...new Set(referenced)].map(id => all.get(id)!);
      if (!attachEvidence(facts, queries)) return gap('Answer source Evidence pages are incomplete');
      const coverage = checksCoverage ? await coverageEvidence(facts) : undefined;
      if (checksCoverage && !coverage) return gap('Answer coverage sources are incomplete');
      const evidenceRefs = [...originals.map(a => `answer:${a.id}`), ...queries.flatMap(q => q.pages.map(p => `query:${q.query.id}:page:${p.page.page}`)), ...queries.flatMap(q => q.evidence.map(e => `evidence:${e.evidence.id}:page:${e.page}`))];
      if (coverage) evidenceRefs.push(...coverage.refs);
      if(selectedSource)evidenceRefs.push(`input:${(selectedSource.input as any).id}`);
      const resolved=record(authored)&&selectedSource&&authored.sessionAlias!==undefined?{...authored,sessionId:String((selectedSource.input as any).sessionId),leafId:(selectedSource.input as any).nativeEntryId}:undefined;
      return { ...resolved?{expected:resolved}:{},actual: { answer: originals.map(a => `Answer #${a.id}, Run #${a.runId}:\n${a.text}`).join('\n\n'), evidenceRefs, evidence: { answers: originals, queries: queries.flatMap(q => q.pages), evidence: queries.flatMap(q => q.evidence), ...(coverage ? { coverage } : {}),...(selectedSource?{selectedSource}:{}), intents: facts.intents ?? [],nativeHistory:facts.nativeHistory??[],providerRequests:facts.providerRequests??[],toolOriginals:facts.toolOriginals??[],runOriginals:facts.runOriginals??[],operations:facts.operations??[] } }, evidenceRefs };
    }
    const selected = selectQueries(check, context, all); if (!selected) return gap('Authored turn cannot be bound to original Query ownership');
    const evidenceRefs = selected.flatMap(q => q.pages.map(p => `query:${q.query.id}:page:${p.page.page}`));
    const parsed = selected.map(parameters); if (parsed.some(p => !p.success)) return gap('Original Query parameters cannot be normalized by the stored contract');
    const params = parsed.flatMap(p => p.success ? [p.data] : []);
    if (check.metricId === 'query.aggregate') {
      if (selected.some(q => q.query.kind !== 'aggregate') || selected.some(q => q.rows.some(row => typeof row.value !== 'number' || (parameters(q).success && params[selected.indexOf(q)]!.groupBy !== null && typeof row[params[selected.indexOf(q)]!.groupBy!] !== 'string')))) return gap('Aggregate rows lack original group keys or numeric values');
      return { actual: selected.flatMap((q, index) => q.rows.map(row => ({ key: params[index]!.groupBy ? row[params[index]!.groupBy!] : 'all', count: row.value }))), evidenceRefs };
    }
    if (check.metricId === 'query.trend') {
      if (selected.some(q => q.query.kind !== 'trend' || q.rows.some(row => typeof row.date !== 'string' || typeof row.gap !== 'boolean' || row.value !== null && typeof row.value !== 'number'))) return gap('Trend rows lack original date grid, gap, or value');
      return { actual: selected.flatMap(q => q.rows.map(row => ({ date: row.date, gap: row.gap, value: row.value }))), evidenceRefs };
    }
    const needsIdentity = check.metricId !== 'query.conditions' || params.some(p => p.deviceIds !== null);
    let identities = new Map<number, string>();
    if (needsIdentity) {
      if (!attachEvidence(facts, selected)) return gap('Original source Evidence pages are incomplete');
      const snapshots = selected.flatMap(q => q.evidence.flatMap(e => e.items));
      const mapped = await sourceIdentities(facts, snapshots); if (!mapped) return gap('Source Device identity cannot be bound through registered import Artifact rows');
      identities = mapped;
      evidenceRefs.push(...selected.flatMap(q => q.evidence.map(e => `evidence:${e.evidence.id}:page:${e.page}`)));
    }
    if (check.metricId === 'query.conditions') {
      const normalized = params.map((p, index) => {
        if (p.deviceIds && (p.deviceIds.length !== 1 || !identities.has(p.deviceIds[0]!))) return undefined;
        const point = p.kind === 'current' || p.kind === 'aggregate' && p.population === 'snapshot';
        return { region: p.region, regions: null, date: point ? selected[index]!.query.interpretation?.requestedDate ?? p.time?.start ?? null : null, start: point ? null : p.time?.start ?? null, endExclusive: point ? null : p.time?.endExclusive ?? null, sourceDeviceId: p.deviceIds ? identities.get(p.deviceIds[0]!) : null, manufacturer: p.manufacturer, category: p.category, status: p.status, snapshotMode: p.snapshotMode, threshold: p.threshold ? { operator: p.threshold.operator, percent: p.threshold.value * 100 } : null };
      });
      if (normalized.some(p => !p)) return gap('Query Device filters are missing an independent source identity');
      const first = normalized[0]!;
      if (!normalized.every(p => equal({ ...p, region: null }, { ...first, region: null }))) return gap('Multiple Query parts have incompatible conditions');
      const regions = [...new Set(normalized.map(p => p!.region))];
      return { actual: regions.length > 1 ? { ...first, region: null, regions } : first, evidenceRefs };
    }
    const rows = selected.flatMap(q => q.rows);
    if (rows.some(row => !Number.isSafeInteger(row.deviceId) || !identities.has(Number(row.deviceId)) || typeof row.scopeKey !== 'string' || !row.scopeKey)) return gap('Query row identity lacks a source Device or scope');
    const id = (row: Record<string, any>) => `${identities.get(row.deviceId)}@${row.scopeKey}`;
    if(check.metricId==='query.facts') {
      if(selected.length!==1||!selected[0]!.query.interpretation)return gap('One complete query interpretation required');
      const interpretation=selected[0]!.query.interpretation!,dates=interpretation.dataDates;
      const actualDate=dates.length===1?dates[0]:null;
      return {actual:{requestedDate:interpretation.requestedDate,actualDataDate:actualDate,snapshotMode:interpretation.snapshotMode,region:params[0]!.region,scopeKey:list(facts.batches).find(batch=>batch.id===selected[0]!.query.batchIds[0])?.scopeKey??null,isStale:actualDate===null?null:actualDate!==interpretation.requestedDate,quantityUnit:interpretation.unit,nullPriceDeviceIds:rows.filter(row=>row.priceCents===null).map(id),ratioUnknown:[]},evidenceRefs};
    }
    if (check.metricId.startsWith('query.set_')) return { actual: [...new Set(rows.map(id))].sort(), evidenceRefs };
    if (check.metricId === 'export.exact') {
      if (selected.length !== 1 || selected[0]!.query.kind !== 'current') return gap('Export Gold projection currently requires one original current-snapshot Query');
      const q = selected[0]!, operations = list(facts.operations).filter(op => record(op) && op.kind === 'export' && op.queryId === q.query.id);
      if (operations.length !== 1) return gap('Original export operation is missing or ambiguous');
      const { kind: _kind, ...operationValue } = operations[0];
      const registered=list(facts.artifacts).find(item=>item.id===operationValue.artifact?.id&&item.protocolValidated===true);
      if(registered&&equal(projectPublicEvidence(operationValue.artifact),projectPublicEvidence(Object.fromEntries(Object.keys(operationValue.artifact).map(key=>[key,registered[key]])))))operationValue.artifact={...operationValue.artifact,protocolValidated:true};
      const parsedOperation = PublicExportOperation.safeParse(projectPublicEvidence(operationValue));
      if (!parsedOperation.success || !parsedOperation.data.artifact) return gap('Original registered export operation/Artifact is unavailable'+(!parsedOperation.success?': '+JSON.stringify(parsedOperation.error.issues):''));
      const operation = parsedOperation.data, artifact = PublicExportArtifact.parse(operation.artifact);
      const copied = artifactFiles(facts).filter(f => record(f) && f.artifactId === artifact.id) as (CopiedFile & { artifactId: number })[];
      await verifyCopiedArtifact(artifact, copied);
      const csvFile = copied.find(f => f.relativePath === 'result.csv'), metadataFile = copied.find(f => f.relativePath === 'metadata.json'), jsonFile = copied.find(f => f.relativePath === 'result.json');
      let metadata: Record<string, any>, fileRows: unknown[], queryRows: unknown[], columns: string[];
      if (operation.format === 'csv' && csvFile && metadataFile) {
        metadata = JSON.parse(await readFile(metadataFile.evidencePath, 'utf8'));
        const records = [...readCsvRecords(csvFile.evidencePath, undefined, csvFile.sha256)];
        columns = records[0] ?? [];
        const required = ['snapshotId', 'batchId', 'deviceId', 'date', 'scopeKey', 'deviceName', 'region', 'category', 'manufacturer', 'distributor', 'status', 'priceCents', 'priceCNY', 'currency', 'unit'];
        if (!equal(columns, required) || !Array.isArray(metadata.columns) || !equal(metadata.columns.map((c: any) => c.name), columns) || records.slice(1).some(r => r.length !== columns.length)) return gap('CSV columns or row widths do not satisfy the full current Query export contract');
        fileRows = records.slice(1);
        const cell = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'string' && (/^[\t\r\n]/.test(value) || /^\s*[=+\-@]/.test(value)) ? `'${value}` : String(value);
        queryRows = q.rows.map(row => columns.map(column => cell(column === 'priceCNY' ? row.priceCents === null ? null : (Number(row.priceCents) / 100).toFixed(2) : row[column])));
      } else if (operation.format === 'json' && jsonFile) {
        const data = JSON.parse(await readFile(jsonFile.evidencePath, 'utf8')); metadata = data.metadata;
        if (!record(metadata) || !Array.isArray(data.rows)) return gap('JSON export lacks full original rows/metadata');
        fileRows = data.rows; queryRows = q.rows; columns = [...new Set(q.rows.flatMap(row => Object.keys(row)))];
      } else return gap('Full registered export contents for this format are unavailable');
      if (!record(metadata) || metadata.contract !== 'medclaw.export-metadata/v1' || metadata.artifactId !== artifact.id || !record(metadata.query) || metadata.totalRows !== q.rows.length || metadata.scope !== 'all_saved' || metadata.query.id !== q.query.id || !['id', 'sessionId', 'runId', 'kind', 'params', 'batchIds', 'scopeDeviceIds', 'warnings', 'calculationVersion', 'resultHash', 'createdAt', 'interpretation'].every(key => equal(metadata.query[key], q.query[key as keyof typeof q.query]))) return gap('Export metadata cannot be bound to the full original Query identity/conditions/interpretation');
      const binding = list(record(facts.aliases) ? facts.aliases.queries : undefined).filter(a => record(a) && a.queryId === q.query.id && typeof a.alias === 'string');
      if (binding.length !== 1) return gap('Export Query does not have an unambiguous controller alias');
      const interpretation = q.query.interpretation;
      if (!interpretation) return gap('Export source Query interpretation is unavailable');
      const scopedBatches = list(facts.batches).filter(b => record(b) && q.query.batchIds.includes(b.id));
      const scopes = [...new Set(scopedBatches.map(b => b.scopeKey))];
      const normalizedMetadata = { requestedDate: interpretation.requestedDate, actualDataDate: interpretation.dataDates.length === 1 ? interpretation.dataDates[0] : null, snapshotMode: interpretation.snapshotMode, region: params[0]!.region, scopeKey: scopes.length === 1 ? scopes[0] : null, isStale: interpretation.isStale, quantityUnit: interpretation.unit, nullPriceDeviceIds: rows.filter(r => r.priceCents === null).map(id).sort() };
      const normalizedRows = rows.map(row => ({ key: `${identities.get(Number(row.deviceId))}|${row.date}`, device: identities.get(Number(row.deviceId)), name: row.deviceName, category: row.category, region: row.region, date: row.date, price: row.priceCents, status: row.status, manufacturer: row.manufacturer, distributor: row.distributor }));
      return { actual: { rows: normalizedRows, sets: [...new Set(rows.map(id))].sort(), format: operation.format, sourceQueryAlias: binding[0].alias, queryId: q.query.id, artifactId: artifact.id, columns, fileRows, queryRows, metadata: normalizedMetadata, fileMetadata: metadata }, evidenceRefs: [...evidenceRefs, ...copied.map(f => 'artifact:'+artifact.id+'/'+f.relativePath), `export:${operation.operationRef}`] };
    }
    if (check.metricId === 'query.numeric') {
      if (selected.some(q => q.query.kind !== 'current') || rows.some(row => row.currency !== 'CNY' || row.priceCents !== null && typeof row.priceCents !== 'number')) return gap('Current price values and original CNY units are unavailable');
      return { actual: rows.filter(row => row.priceCents !== null).map(row => ({ id: id(row), value: row.priceCents, unit: 'CNY cents' })), evidenceRefs };
    }
    if (check.metricId === 'diff.exact') {
      if (selected.some(q => q.query.kind !== 'changes') || rows.some(row => typeof row.kind !== 'string' || typeof row.date !== 'string' || !Object.hasOwn(row, 'oldValue') || !Object.hasOwn(row, 'newValue'))) return gap('Original change event type/date/old/new facts are unavailable');
      return { actual: rows.map(row => ({ key: `${id(row)}|${row.date}|${row.field ?? row.kind}`, type: row.kind, old: row.oldValue, new: row.newValue })), evidenceRefs };
    }
    return undefined;
  } catch(error) { return gap('Verified business projection failed: '+(error instanceof Error?error.message:'unknown')); }
}
