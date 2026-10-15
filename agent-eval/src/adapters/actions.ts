import {ExportOperationSchema} from '../../../packages/contracts/src/export.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, realpath,readFile } from 'node:fs/promises';
import { join, resolve,dirname } from 'node:path';
import type { ProductResource, RegisteredAction, RegisteredStep } from '../evaluation.ts';
import type { ResolvedRunConfig } from '../types.ts';
import type { SessionCheckpoint, SessionCheckpointPage, SessionInputPage,CompactionOperationView } from '../../../packages/contracts/src/session.ts';
import type { SessionMessagePage } from '../../../packages/contracts/src/messages.ts';
import type { RunView } from '../../../packages/contracts/src/run.ts';
import { ProductAdapter, unwrap } from './product.ts';
import { verifyPublishedConfiguration } from './configuration.ts';
import { copyEvidenceTree, within } from './files.ts';
import {parseAuthoredSource} from '../independent-gold.ts';
import type {Snapshot} from '../../../packages/contracts/src/query.ts';
import type {WorkspaceSelection} from '../../../packages/contracts/src/workspace.ts';
import type {PublicMaterial} from '../datasets.ts';
import {safeError} from '../../../packages/contracts/src/error.ts';
import {TOOL_READ_RULES} from '../../../packages/contracts/src/tool.ts';

export interface AliasState {
  sessions: Map<string, { id: number; nativeSessionId: string }>;
  runs: Map<string, number>; inputs: Map<string, { sessionId: number; clientSequence: number; inputId: number | null }>;
  batches: Map<string, number>; queries: Map<string, number>; checkpoints: Map<string, SessionCheckpoint>;
  operations: Map<string, { kind: 'import' | 'export' | 'session_checkpoint' | 'compaction'; operationRef: string; sessionId?: number; requestedAt?: string }>;
}
export const createAliasState = (): AliasState => ({ sessions: new Map(), runs: new Map(), inputs: new Map(), batches: new Map(), queries: new Map(), checkpoints: new Map(), operations: new Map() });
function identity<T>(map: Map<string, T>, alias: string): T { const value = map.get(alias); if (value === undefined) throw new Error(`unknown_alias:${alias}`); return value; }
function bind<T>(map: Map<string, T>, alias: string, value: T) { if (map.has(alias)) throw new Error(`duplicate_alias:${alias}`); map.set(alias, value); }

export class ActionExecutor {
  readonly aliases = createAliasState();
  lastSendAlias: string | null = null;
  private restoreRequests = new Map<string, { sessionId: number; targetLeafId: string; expectedStorageVersion: number; expectedWorkspaceRevision: number }>();
  constructor(readonly product: ProductAdapter, readonly config: ResolvedRunConfig, readonly datasetRoot: string, readonly trialRoot: string,
    readonly capturedResources: readonly ProductResource[] = [],readonly publicMaterials:readonly PublicMaterial[] = [],readonly verifyPublicMaterials?:()=>Promise<PublicMaterial[]>) {}
  private session(alias: string) { return identity(this.aliases.sessions, alias).id; }
  private async model() {
    return verifyPublishedConfiguration(this.product, this.config);
  }
  private async operation(alias: string, kind: 'import' | 'export' | 'session_checkpoint') {
    const operation = identity(this.aliases.operations, alias); if (operation.kind !== kind) throw new Error('operation_alias_kind_mismatch'); return operation.operationRef;
  }
  async runView(alias: string): Promise<RunView> {
    const id = identity(this.aliases.runs, alias), result = unwrap(await this.product.request('run.read', { runId: id }));
    if (result.kind !== 'one' || !result.run || result.run.id !== id || !this.product.instanceIds.includes(result.run.instanceId)) throw new Error('run_identity_mismatch');
    return result.run;
  }
  async checkpoints(sessionAlias: string) {
    const sessionId = this.session(sessionAlias), pages = []; let cursor: number | null = null; const seen = new Set<number>();
    do {
      const page: SessionCheckpointPage = unwrap(await this.product.request('session.checkpoints.read', { sessionId, afterAnswerId: cursor, limit: 100 }));
      if (page.sessionId !== sessionId || page.nextAnswerId !== null && seen.has(page.nextAnswerId)) throw new Error('checkpoint_identity_or_cursor_mismatch');
      pages.push(page); if (page.nextAnswerId !== null) seen.add(page.nextAnswerId); cursor = page.nextAnswerId;
    } while (cursor !== null);
    for (const [alias, runId] of this.aliases.runs) {
      const checkpoint = pages.flatMap(page => page.items).find(item => item.runId === runId);
      if (checkpoint) this.aliases.checkpoints.set(`${alias}:checkpoint`, checkpoint);
    }
    return pages;
  }
  async wait(trigger: RegisteredStep['trigger'], targetAlias: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const alias = targetAlias ?? this.lastSendAlias;
      if (trigger === 'ready') { if (this.product.ready) return; }
      else {
        if (!alias) throw new Error('trigger_missing_target_alias');
        if (trigger === 'run_settled') {
          const run = await this.runView(alias);
          if (['completed', 'failed', 'cancelled'].includes(run.status) && (run.stoppedAt !== null || run.cleanup?.executionStarted === false)
            && run.cleanup?.stopConfirmed === true && run.cleanup.requiredPersistenceComplete === true && run.cleanup.inputsSettled === true && run.cleanup.resourcesReleased === true) {
            if (run.kind === 'agent') {
              const answer = unwrap(await this.product.request('answer.read', { runId: run.id }));
              if (answer) { if (answer.runId !== run.id || answer.sessionId !== run.sessionId) throw new Error('answer_identity_mismatch'); answer.queryIds.forEach((id, i) => this.aliases.queries.set(`${alias}:query:${i + 1}`, id)); }
            }
            return;
          }
        } else if (trigger === 'input_delivered') {
          const input = identity(this.aliases.inputs, alias), result = unwrap(await this.product.request('session.readInput', { sessionId: input.sessionId, clientSequence: input.clientSequence }));
          if (result?.deliveredAt !== null && result?.deliveredAt !== undefined) return;
        } else if (trigger === 'tool_result_saved') {
          const runId = identity(this.aliases.runs, alias); let page = 1;
          for (;;) {
            const result = unwrap(await this.product.request('tool.read', { runId, page, pageSize: TOOL_READ_RULES.maxPageSize }));
            if (result.items.some(item => ['succeeded', 'failed', 'cancelled'].includes(item.status))) return;
            if (page * result.pageSize >= result.totalRows) break; page++;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(`step_trigger_timeout:${trigger}`);
      await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
  async execute(action: RegisteredAction, signal?:AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const product = this.product, operationRef = randomUUID();
    switch (action.action) {
      case 'new_session': {
        if (this.aliases.sessions.has(action.alias)) throw new Error('duplicate_alias');
        const workspace = unwrap(await product.request('workspace.read', {}));
        const result = unwrap(await product.request('session.create', { expectedWorkspaceRevision: action.expectedWorkspaceRevision ?? workspace.revision }, operationRef));
        bind(this.aliases.sessions, action.alias, { id: result.session.id, nativeSessionId: result.session.nativeSessionId }); return result;
      }
      case 'select_session': {
        const workspace = unwrap(await product.request('workspace.read', {}));
        return unwrap(await product.request('session.select', { sessionId: this.session(action.sessionAlias), expectedWorkspaceRevision: action.expectedWorkspaceRevision ?? workspace.revision }, operationRef));
      }
      case 'select_resources': {
        const sessionId = this.session(action.sessionAlias), listed = unwrap(await product.request('resources.list', { source: 'selection', sessionId }));
        if (listed.source !== 'selection' || listed.sessionId !== sessionId || listed.catalogError) throw new Error('resource_catalog_identity_or_availability_mismatch');
        const selected = action.skills.map(skill => {
          const items = listed.items.filter(item => item.ref.kind === 'skill' && item.ref.id === skill.id && item.ref.version === skill.version);
          if (items.length !== 1 || items[0]!.availability !== 'ready') throw new Error('resource_unavailable:' + skill.id);
          const captures = this.capturedResources.filter(resource => resource.kind === 'skill' && resource.id === skill.id && resource.version === skill.version);
          if (captures.length !== 1) throw new Error('captured_resource_missing:' + skill.id);
          const capture = captures[0]!, item = items[0]!;
          if (new Set(capture.files.map(file => file.path)).size !== capture.files.length
            || !isDeepStrictEqual(capture.files.map(file => file.path).sort(), item.files.map(file => file.file).sort())) throw new Error('captured_resource_file_set_changed:' + skill.id);
          return { item, capture };
        });
        const selection = { prompt: listed.selection.prompt, skills: selected.map(resource => resource.item.ref) };
        const receipt = unwrap(await product.request('resources.select', { sessionId, expectedConfigVersion: listed.configVersion, selection }, operationRef));
        try {
          if (receipt.sessionId !== sessionId || !isDeepStrictEqual(receipt.selection, selection)) throw new Error('resource_selection_identity_mismatch');
          for (const resource of selected) for (const file of resource.capture.files) {
            const actual = unwrap(await product.request('resources.read', { source: 'selection', sessionId, resourceRef: resource.item.ref, file: file.path }));
            if (actual.source !== 'selection' || actual.sessionId !== sessionId || actual.configVersion !== receipt.configVersion
              || !isDeepStrictEqual(actual.resourceRef, resource.item.ref) || actual.file !== file.path
              || actual.content !== file.content || actual.bytes !== file.bytes) throw new Error('captured_resource_content_changed:' + resource.capture.id + ':' + file.path);
          }
        } catch (error) {
          try {
            const restored = unwrap(await product.request('resources.select', { sessionId, expectedConfigVersion: receipt.configVersion, selection: listed.selection }));
            product.record('resource_selection_rollback', { sessionId, restored });
          } catch (rollback) { throw new Error('resource_selection_rollback_failed:' + (rollback instanceof Error ? rollback.message : 'unknown'), { cause: error }); }
          throw error;
        }
        return receipt;
      }
      case 'select_workspace': {
        const workspace = unwrap(await product.request('workspace.read', {}));
        let selection,deviceIds;
        if(action.device) {
          const source=parseAuthoredSource(await readFile(join(this.datasetRoot,'materials/procurement.csv'),'utf8'));
          const keys=new Set(source.filter(row=>row.device===action.device).map(row=>row.key));
          const matches:{row:Snapshot;selection:WorkspaceSelection}[]=[];
          for(const batchId of (action.batchAliases?.map(alias=>identity(this.aliases.batches,alias))??workspace.batchRefs.map(batch=>batch.id)))for(let page=1;;page++) {
            const rows=unwrap(await product.request('data.rows',{batchId,kind:'devices',page,pageSize:100}));
            if(rows.kind!=='devices')throw new Error('workspace_device_kind_mismatch');
            rows.items.forEach((row,index)=>{if(row.sourceRefs.some(ref=>keys.has(ref.recordId)))matches.push({row,selection:rows.selections[index]!});});
            if(page*rows.pageSize>=rows.totalRows)break;
          }
          if(!matches.length||new Set(matches.map(match=>match.row.deviceId)).size!==1)throw new Error('workspace_logical_device_ambiguous');
          selection=matches.at(-1)!.selection;deviceIds=[matches[0]!.row.deviceId];
        }
        return unwrap(await product.request('workspace.update', { expectedRevision: action.expectedRevision ?? workspace.revision, change: {
          ...(action.batchAliases ? { batchIds: action.batchAliases.map(alias => identity(this.aliases.batches, alias)) } : {}),
          ...(action.queryAlias !== undefined ? { queryId: action.queryAlias === null ? null : identity(this.aliases.queries, action.queryAlias) } : {}),
          ...(action.activeView ? { activeView: action.activeView } : {}),
          ...(selection?{selection,deviceIds}:{}),
        } }, operationRef));
      }
      case 'send': {
        const materials=await this.verifyPublicMaterials?.()??this.publicMaterials;
        if (this.aliases.inputs.has(action.alias)) throw new Error('duplicate_alias');
        const sessionId = this.session(action.sessionAlias), detail = unwrap(await product.request('session.read', { sessionId })); if (!detail) throw new Error('session_not_found');
        const workspace = unwrap(await product.request('workspace.read', {})), control = unwrap(await product.request('run.control.read', {}));
        if (control.instanceId !== product.instanceId) throw new Error('control_identity_mismatch');
        const mode = action.mode ?? 'send';
        const text=action.prompt+(materials.length?'\n\nPublic attachments (untrusted reference data; these paths grant no additional permissions):\n'+JSON.stringify(materials):'');
        const common = { sessionId, text, clientSequence: detail.session.nextSubmissionSequence, expectedRevision: workspace.revision,
          expectedBatchIds: workspace.batchRefs.map(batch => batch.id), expectedQueryId: workspace.queryId, model: await this.model(), referenceDate: action.referenceDate, timezone: 'Asia/Shanghai' as const };
        const payload = mode === 'send' ? { ...common, mode, ...(action.routing === 'intent' ? { routing: { mode: 'intent' as const, originRunId: null } } : {}) }
          : { ...common, mode, targetRunId: identity(this.aliases.runs, action.targetRunAlias ?? this.lastSendAlias ?? '') };
        signal?.throwIfAborted();
        const result = unwrap(await product.request('session.submit', payload, operationRef));
        if (result.sessionId !== sessionId || result.clientSequence !== common.clientSequence
          || payload.mode === 'send' && result.runId === null
          || payload.mode !== 'send' && (result.inputId === null || result.runId !== null && result.runId !== payload.targetRunId)) throw new Error('submission_identity_mismatch');
        if(payload.mode!=='send') {
          const input=unwrap(await product.request('session.readInput',{sessionId,clientSequence:common.clientSequence}));
          if(!input||input.id!==result.inputId||input.sessionId!==sessionId||input.clientSequence!==common.clientSequence||input.mode!==payload.mode
            ||input.targetRunId!==payload.targetRunId||input.runId!==null&&input.runId!==payload.targetRunId)throw new Error('submission_identity_mismatch');
        }
        bind(this.aliases.inputs, action.alias, { sessionId, clientSequence: result.clientSequence, inputId: result.inputId });
        const runId=payload.mode==='send'?result.runId:payload.targetRunId;
        if (runId !== null) bind(this.aliases.runs, action.alias, runId);
        this.lastSendAlias = action.alias; return result;
      }
      case 'import': {
        if (this.aliases.operations.has(action.alias)) throw new Error('duplicate_alias');
        const materialRoot = await realpath(join(this.datasetRoot, 'materials')), source = resolve(this.datasetRoot, action.materialRef); within(materialRoot, source);
        const projection = join(dirname(product.paths.dataRoot), 'projection', operationRef); const files = await copyEvidenceTree(source, projection);
        product.record('material_projection', { materialRef: action.materialRef, files });
        const { fileToken } = product.fileTokens.issue(1, product.instanceId, operationRef, projection);
        bind(this.aliases.operations, action.alias, { kind: 'import', operationRef });
        unwrap(await product.request('import.preview', { operationRef, fileToken, mappingVersion: 'medclaw.snapshot/v1' }, operationRef));
        const result = unwrap(await product.request('import.commit', { operationRef, fileToken }, operationRef));
        result.result?.batchIds.forEach((id, index) => bind(this.aliases.batches, `${action.alias}:batch:${index + 1}`, id)); return result;
      }
      case 'read_control': return unwrap(await product.request('run.control.read', {}));
      case 'read_messages': return readAllMessages(product, this.session(action.sessionAlias));
      case 'list_inputs': return listAllInputs(product, this.session(action.sessionAlias));
      case 'read_input': {
        const original = identity(this.aliases.inputs, action.inputAlias);
        if (original.sessionId !== this.session(action.sessionAlias)) throw new Error('input_alias_session_mismatch');
        return unwrap(await product.request('session.readInput', { sessionId: original.sessionId, clientSequence: original.clientSequence }));
      }
      case 'cancel': return unwrap(await product.request('run.cancel', { runId: identity(this.aliases.runs, action.runAlias) }, operationRef));
      case 'restart': { const ready = await product.restart(); await verifyPublishedConfiguration(product, this.config); return ready; }
      case 'compact': {
        const sessionId = this.session(action.sessionAlias), detail = unwrap(await product.request('session.read', { sessionId })); if (!detail) throw new Error('session_not_found');
        const model=await this.model();signal?.throwIfAborted();
        bind(this.aliases.operations, `compaction:${operationRef}`, { kind: 'compaction', operationRef, sessionId });
        let result:CompactionOperationView|null = unwrap(await product.request('session.compact', { sessionId, expectedStorageVersion: detail.session.storageVersion, model }, operationRef));
        const deadline=product.deadlineAt??Date.now()+30000;
        for(;;) {
          signal?.throwIfAborted();
          if(!result||result.sessionId!==sessionId||result.operationRef!==operationRef)throw new Error('compaction_identity_mismatch');
          if(result.error||['failed','cancelled','interrupted','unconfirmed'].includes(result.status)) {
            const provider=result.calls.find(call=>call.error?.code==='provider_request_failed')?.error;
            return unwrap({ok:false,error:provider??result.error??safeError('compaction_failed')});
          }
          if(result.receipt&&['completed','no_op'].includes(result.status)&&result.canContinue)return result;
          if(Date.now()>=deadline)throw new Error('compaction_wait_timeout');
          await Bun.sleep(Math.min(25,Math.max(1,deadline-Date.now())));
          result=unwrap(await product.request('session.compaction.read',{sessionId,operationRef}));
        }
      }
      case 'read_checkpoints': return this.checkpoints(action.sessionAlias);
      case 'restore_checkpoint': {
        const sessionId = this.session(action.sessionAlias); await this.checkpoints(action.sessionAlias);
        const checkpoint = identity(this.aliases.checkpoints, action.checkpointAlias), detail = unwrap(await product.request('session.read', { sessionId })); if (!detail) throw new Error('session_not_found');
        const workspace = unwrap(await product.request('workspace.read', {}));
        const existing = this.aliases.operations.get(action.operationAlias), ref = existing?.operationRef ?? operationRef;
        if (existing && existing.kind !== 'session_checkpoint') throw new Error('operation_alias_kind_mismatch');
        if (!existing) bind(this.aliases.operations, action.operationAlias, { kind: 'session_checkpoint', operationRef: ref, sessionId });
        const previous = this.restoreRequests.get(action.operationAlias);
        const request = { sessionId, targetLeafId: checkpoint.nativeLeafId, expectedStorageVersion: action.expectedStorageVersion ?? previous?.expectedStorageVersion ?? detail.session.storageVersion,
          expectedWorkspaceRevision: action.expectedWorkspaceRevision ?? previous?.expectedWorkspaceRevision ?? workspace.revision };
        if (!previous) this.restoreRequests.set(action.operationAlias, request);
        return unwrap(await product.request('session.restoreCheckpoint', request, ref));
      }
      case 'restore_session': {
        const sessionId = this.session(action.sessionAlias), detail = unwrap(await product.request('session.read', { sessionId })); if (!detail) throw new Error('session_not_found');
        return unwrap(await product.request('session.restore', { sessionId, expectedLeafId: detail.session.leafId }, operationRef));
      }
      case 'export': {
        const queryId = identity(this.aliases.queries, action.queryAlias), source = { operationRef, queryId, answerId: null, format: action.format };
        const destinationRoot = join(dirname(product.paths.dataRoot), 'delivery'); await mkdir(destinationRoot, { recursive: true });
        const grant = product.destinations.issue(1, product.instanceId, source, join(destinationRoot, operationRef));
        bind(this.aliases.operations, action.operationAlias, { kind: 'export', operationRef, requestedAt: new Date().toISOString() });
        let operation = ExportOperationSchema.parse(unwrap(await product.request('export.create', { ...source, destinationToken: grant.destinationToken }, operationRef)));
        const deadline = product.deadlineAt ?? Date.now() + 30000;
        while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(operation.state)) {
          if (Date.now() >= deadline) throw new Error('export_endpoint_timeout');
          await Bun.sleep(25); const current = unwrap(await product.request('export.read', { operationRef }));
          if (!current || current.operationRef !== operationRef) throw new Error('export_operation_identity_mismatch'); operation = current;
        }
        return operation;
      }
      case 'read_operation': {
        const operationRef = await this.operation(action.operationAlias, action.kind);
        return unwrap(await product.request('evidence.readOperation', { kind: action.kind, operationRef }));
      }
      case 'recover_operation': case 'cancel_operation': {
        if (action.kind === 'session_checkpoint') throw new Error('checkpoint_operation_is_read_only');
        const operationRef = await this.operation(action.operationAlias, action.kind), method = `${action.kind}.${action.action === 'recover_operation' ? 'recover' : 'cancel'}` as 'import.recover' | 'import.cancel' | 'export.recover' | 'export.cancel';
        return unwrap(await product.request(method, { operationRef }, operationRef));
      }
    }
  }
}

export async function readAllMessages(product: ProductAdapter, sessionId: number) {
  const pages = []; let cursor: string | null = null, leafId: string | null = null; const seen = new Set<string>();
  do {
    const page: SessionMessagePage = unwrap(await product.request('session.messages.read', { sessionId, leafId, afterEntryId: cursor, limit: 100 }));
    if (page.sessionId !== sessionId || pages.length && (page.leafId !== leafId || page.nativeSessionId !== pages[0]!.nativeSessionId) || page.nextEntryId !== null && seen.has(page.nextEntryId)) throw new Error('message_identity_or_cursor_mismatch');
    pages.push(page); leafId = page.leafId; cursor = page.nextEntryId; if (cursor !== null) seen.add(cursor);
  } while (cursor !== null); return pages;
}
export async function listAllInputs(product: ProductAdapter, sessionId: number) {
  const pages = []; let cursor: number | null = null; const seen = new Set<number>();
  do {
    const page: SessionInputPage = unwrap(await product.request('session.listInputs', { sessionId, afterClientSequence: cursor, limit: 100 }));
    if (page.sessionId !== sessionId || page.nextClientSequence !== null && seen.has(page.nextClientSequence)) throw new Error('input_identity_or_cursor_mismatch');
    pages.push(page); cursor = page.nextClientSequence; if (cursor !== null) seen.add(cursor);
  } while (cursor !== null); return pages;
}
