import { parseSkillBlock, type AgentSession, type SessionManager } from '@earendil-works/pi-coding-agent';
import { AppErrorSchema, safeError, type AppError } from '../../contracts/src/error';
import type { InputAdapterPort, InputBinding, InputCancelProof, InputControl, InputSettlementProof, InputStore } from '../../contracts/src/session';
import type { WorkspaceContext } from '../../contracts/src/workspace';
import { join } from 'node:path';
import { NativeInputReceiptSchema, RESOURCE_LIMITS, resourceRefKey, type FrozenRunResources, type NativeInputReceipt } from '../../contracts/src/resources';
import { contextMessageText } from './messages';
import { verifyRunResourceFiles } from './resource-loader';

type Message = Parameters<AgentSession['agent']['steer']>[0];
type Failure = Parameters<InputStore['recordInputFailure']>[1];
type Consumption = Parameters<InputStore['recordInputConsumption']>[1];
type Removal = Extract<InputCancelProof, { kind: 'removed' }>;
export interface PiInputAdapterCallbacks {
  runId: number; sessionId: number;
  delivered(input: InputBinding, at: string): void;
  consumed(input: InputBinding, fact: Consumption): void;
  failed(input: InputBinding, fact: Failure): void;
  cancelled?(proof: InputCancelProof, at: string): void;
  fatal(error: AppError): void;
  /** Native source/identity corruption invalidates history; persistence failure alone does not. */
  nativeStateInvalid?(): void;
  admissionClosed(): void;
}
type Record = { input: InputBinding; message?: Message; nativeInput?: NativeInputReceipt; started: boolean; entryId?: string; appendOrder?: number; removed?: Removal; unknown: boolean; failed: boolean };
function latch<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

/** Composes public Pi methods. Pi retains exclusive ownership of its scheduling loop. */
export class PiInputAdapter implements InputAdapterPort {
  private readonly records = new Map<number, Record>();
  private readonly objects = new WeakMap<object, Record>();
  private readonly queued = new Set<Record>();
  private readonly pendingSaves = new Map<string, () => void>();
  private readonly cancellations = new Map<number, ReturnType<typeof latch<InputCancelProof>>>();
  private readonly longTasks = new Set<Promise<void>>();
  private readonly removals: Removal[] = [];
  private preflight = Promise.resolve();
  private scope?: { record: Record; epoch: number; count: number; dispatch: ReturnType<typeof latch<void>> };
  private accepting = true;
  private epoch = 0;
  private invalid = false;
  private appendOrder = 0;
  private confirmedOrder = 0;
  private consumedWorkspace: { inputId: number; nativeEntryId: string; workspaceContext: WorkspaceContext } | null = null;
  private readonly originals: { prompt: AgentSession['agent']['prompt']; steer: AgentSession['agent']['steer']; followUp: AgentSession['agent']['followUp']; append: SessionManager['appendMessage'] };
  private readonly installed: typeof this.originals;
  private readonly sessionOriginals: Pick<AgentSession, 'prompt' | 'steer' | 'followUp'>;
  private readonly sessionInstalled: Pick<AgentSession, 'prompt' | 'steer' | 'followUp'>;
  private readonly unsubscribe: () => void;

  constructor(private readonly session: AgentSession, private readonly manager: SessionManager, private readonly callbacks: PiInputAdapterCallbacks, private readonly resources?: { frozen: FrozenRunResources; workdir: string }) {
    const agent = session.agent;
    this.sessionOriginals = { prompt: session.prompt.bind(session), steer: session.steer.bind(session), followUp: session.followUp.bind(session) };
    const rejectUncontrolled = () => {
      if (this.scope) this.markUnknown(this.scope.record, 'delivery_unconfirmed'); else this.block();
      return Promise.reject(safeError('input_delivery_unknown'));
    };
    this.sessionInstalled = { prompt: rejectUncontrolled, steer: rejectUncontrolled, followUp: rejectUncontrolled };
    session.prompt = this.sessionInstalled.prompt; session.steer = this.sessionInstalled.steer; session.followUp = this.sessionInstalled.followUp;
    this.originals = { prompt: agent.prompt.bind(agent), steer: agent.steer.bind(agent), followUp: agent.followUp.bind(agent), append: manager.appendMessage };
    session.setSteeringMode('one-at-a-time'); session.setFollowUpMode('one-at-a-time');
    this.installed = {
      prompt: (input: string | Message | Message[]) => {
        if (typeof input === 'string') { this.block(); throw safeError('input_delivery_unknown'); }
        const messages = Array.isArray(input) ? input : [input];
        const users = messages.filter(message => message.role === 'user');
        const record = this.capture(users);
        if (agent.state.isStreaming) throw safeError('state_conflict');
        let task: Promise<void>;
        try { task = this.originals.prompt(input); }
        catch (error) { this.markUnknown(record, 'delivery_unconfirmed'); throw error; }
        if (!agent.state.isStreaming && !record.started) { this.markUnknown(record, 'delivery_unconfirmed'); throw safeError('input_delivery_unknown'); }
        this.acceptDispatch(record);
        return task;
      },
      steer: message => { const record = this.capture([message]); this.originals.steer(message); this.queued.add(record); this.acceptDispatch(record); },
      followUp: message => { const record = this.capture([message]); this.originals.followUp(message); this.queued.add(record); this.acceptDispatch(record); },
      append: message => {
        const record = this.objects.get(message);
        let entryId: string;
        try { entryId = this.originals.append.call(manager,message); }
        catch (error) { if (record) this.markUnknown(record, 'append_failed'); else if (message.role === 'user') this.block(); throw error; }
        if (record) {
          if (record.removed || record.entryId && record.entryId !== entryId) { this.block(); return entryId; }
          record.entryId = entryId;
          const order = record.appendOrder ??= ++this.appendOrder;
          const fact: Consumption = { sessionId: record.input.sessionId, runId: record.input.targetRunId, nativeEntryId: entryId, at: new Date().toISOString(), ...(record.nativeInput ? { nativeInput: record.nativeInput } : {}) };
          this.save(`consumed:${record.input.inputId}`, () => {
            this.callbacks.consumed(record.input, fact);
            if (order >= this.confirmedOrder) {
              this.confirmedOrder = order;
              this.consumedWorkspace = record.input.workspaceContext ? { inputId: record.input.inputId, nativeEntryId: entryId,
                workspaceContext: structuredClone(record.input.workspaceContext) } : null;
            }
          });
        } else if (message.role === 'user') this.block();
        return entryId;
      },
    };
    agent.prompt = this.installed.prompt; agent.steer = this.installed.steer; agent.followUp = this.installed.followUp; manager.appendMessage = this.installed.append;
    // AgentSession registered its awaited persistence listener during construction.
    this.unsubscribe = agent.subscribe(async event => {
      if (event.type === 'message_start' && event.message.role === 'user') {
        const record = this.objects.get(event.message);
        if (!record || record.removed) { this.block(); return; }
        record.started = true; this.queued.delete(record);
      }
      if (event.type === 'turn_end') await this.serial(() => this.applyCancellations());
      if (event.type === 'agent_end') this.closeAdmission();
    });
  }

  readControl(): InputControl { return { runId: this.callbacks.runId, acceptingInputs: this.accepting && !this.invalid, blockReasons: this.invalid ? [safeError('input_delivery_unknown')] : this.pendingSaves.size ? [safeError('storage_write_failed')] : [] }; }
  readConsumedWorkspace(): { inputId: number; nativeEntryId: string; workspaceContext: WorkspaceContext } | null {
    if (this.invalid || this.appendOrder > this.confirmedOrder) throw safeError('state_conflict');
    return this.consumedWorkspace ? structuredClone(this.consumedWorkspace) : null;
  }
  hasInput(inputId: number): boolean { return this.records.has(inputId); }
  async waitForCompletion(outcome: 'completed' | 'failed' | 'cancelled'): Promise<InputSettlementProof> {
    await Promise.all([...this.longTasks]);
    return this.close(this.callbacks.runId, outcome);
  }
  closeAdmission(): void { if (!this.accepting) return; this.accepting = false; this.epoch++; this.callbacks.admissionClosed(); }
  /** Stop clears native sources immediately; removal proofs wait for idle convergence. */
  stop(): void { this.closeAdmission(); this.session.clearQueue(); }
  private block(error = safeError('input_delivery_unknown')) {
    if (!this.invalid) { this.invalid = true; this.callbacks.nativeStateInvalid?.(); }
    this.closeAdmission(); this.callbacks.fatal(error);
  }
  private save(key: string, operation: () => void) {
    try { operation(); this.pendingSaves.delete(key); }
    catch { this.pendingSaves.set(key, operation); this.closeAdmission(); this.callbacks.fatal(safeError('storage_write_failed')); }
  }
  private failure(record: Record, proof: Failure['proof'], error?: AppError) {
    const fact: Failure = { sessionId: record.input.sessionId, targetRunId: record.input.targetRunId, at: new Date().toISOString(), error: error ?? safeError(proof.kind === 'delivery_unknown' ? 'input_delivery_unknown' : proof.reason === 'hook_handled' ? 'input_hook_handled' : 'input_invalid'), proof };
    this.save(`failure:${record.input.inputId}`, () => this.callbacks.failed(record.input, fact));
  }
  private markUnknown(record: Record, reason: Extract<Failure['proof'], { kind: 'delivery_unknown' }>['reason']) {
    record.unknown = true; this.queued.delete(record); this.failure(record, { kind: 'delivery_unknown', reason }); this.block();
  }
  private capture(messages: Message[]): Record {
    const scope = this.scope;
    if (!scope) { this.block(); throw safeError('input_delivery_unknown'); }
    const record = scope.record;
    if (!this.accepting || scope.epoch !== this.epoch || record.input.stopEpoch !== 0) { record.failed = true; throw safeError('input_invalid'); }
    if (messages.length !== 1 || messages[0]!.role !== 'user' || scope.count++) { this.markUnknown(record, 'delivery_unconfirmed'); throw safeError('input_delivery_unknown'); }
    if (record.input.inputPlan) {
      const text = contextMessageText(messages[0]!.content), plan = record.input.inputPlan;
      const reject = (): never => { throw safeError('resource_unavailable', undefined, { reason: 'resource_expansion_failed' }); };
      if (text === null || !this.resources || this.resources.frozen.sessionId !== record.input.sessionId) reject();
      if (plan.kind === 'plain') { if (text !== plan.dispatchText) reject(); }
      else {
        const snapshot = this.resources!.frozen.available.find(s => resourceRefKey(s.ref) === resourceRefKey(plan.resourceRef!)); if (!snapshot) reject();
        const location = join(this.resources!.workdir, 'resources', snapshot!.entry);
        if (plan.kind === 'skill') { const block = parseSkillBlock(text!); if (!block || block.name !== snapshot!.name || block.location !== location) reject(); }
        else if (!this.session.promptTemplates.some(p => p.name === snapshot!.name && p.filePath === location) || text === plan.dispatchText) reject();
      }
      const receipt = NativeInputReceiptSchema.safeParse({ text });
      const limit = record.input.nativeReceiptLimitBytes ?? RESOURCE_LIMITS.nativeReceiptBytes;
      if (!receipt.success || !Number.isSafeInteger(limit) || limit < 0 || Buffer.byteLength(JSON.stringify(receipt.data), 'utf8') > limit) throw safeError('resource_unavailable', undefined, { reason: 'resource_too_large' });
      record.nativeInput = receipt.data;
    } else if (this.resources) throw safeError('state_conflict');
    record.message = messages[0]!; this.objects.set(record.message, record); return record;
  }
  private acceptDispatch(record: Record) {
    const at = new Date().toISOString();
    this.save(`delivery:${record.input.inputId}`, () => this.callbacks.delivered(record.input, at));
    this.scope!.dispatch.resolve();
  }
  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.preflight.then(operation); this.preflight = task.then(() => {}, () => {}); return task;
  }
  async deliver(input: InputBinding): Promise<void> {
    if (input.targetRunId !== this.callbacks.runId || input.sessionId !== this.callbacks.sessionId) throw safeError('state_conflict');
    const prior = this.records.get(input.inputId);
    if (prior) { if (JSON.stringify(prior.input) !== JSON.stringify(input)) throw safeError('state_conflict'); return; }
    const record: Record = { input: structuredClone(input), started: false, unknown: false, failed: false }; this.records.set(input.inputId, record);
    await this.serial(async () => {
      if (!this.accepting) { record.failed = true; this.failure(record, { kind: 'not_consumed', reason: 'dispatch_rejected' }); return; }
      const dispatch = latch<void>(); this.scope = { record, epoch: this.epoch, count: 0, dispatch };
      let task: Promise<void>;
      try {
        if (this.resources) await verifyRunResourceFiles(this.resources.workdir, this.resources.frozen);
        const text = input.inputPlan?.dispatchText ?? input.text;
        task = input.mode === 'send' ? this.sessionOriginals.prompt(text, { expandPromptTemplates: !!input.inputPlan })
          : input.mode === 'steer' ? this.sessionOriginals.steer(text) : this.sessionOriginals.followUp(text);
      } catch (error) { task = Promise.reject(error); }
      // Completion of a handled/rejected preflight also releases the short latch.
      const observed = task.then(() => {
        if (!record.message && !record.failed && !record.unknown) { record.failed = true; this.failure(record, { kind: 'not_consumed', reason: 'hook_handled' }); }
      }, error => {
        const known = AppErrorSchema.safeParse(error);
        if (!record.message && !record.unknown) { record.failed = true; this.failure(record, { kind: 'not_consumed', reason: 'dispatch_rejected' }, known.success ? known.data : undefined); }
        if (known.success) { this.closeAdmission(); this.callbacks.fatal(known.data); }
        else if (!record.entryId && !record.unknown) this.markUnknown(record, 'delivery_unconfirmed');
      }).finally(() => dispatch.resolve());
      this.longTasks.add(observed); void observed.finally(() => this.longTasks.delete(observed));
      await dispatch.promise;
      if (record.failed && !record.message) { /* Failure has already been recorded. */ }
      this.scope = undefined;
    });
  }
  cancel(inputId: number): Promise<InputCancelProof> {
    const record = this.records.get(inputId);
    if (!record) return Promise.resolve({ kind: 'unknown', inputId, error: safeError('input_delivery_unknown') });
    if (record.entryId) return Promise.resolve({ kind: 'consumed', inputId, runId: this.callbacks.runId, nativeEntryId: record.entryId });
    if (record.removed) return Promise.resolve(record.removed);
    const prior = this.cancellations.get(inputId); if (prior) return prior.promise;
    const request = latch<InputCancelProof>(); this.cancellations.set(inputId, request);
    if (this.session.isIdle) void this.serial(() => { if (this.session.isIdle) this.applyCancellations(); });
    return request.promise;
  }
  /** Called only inside the preflight lock at awaited turn_end or confirmed idle. */
  private applyCancellations(all = false) {
    const targets = new Set(all ? [...this.queued].map(record => record.input.inputId) : this.cancellations.keys());
    const removable = [...this.queued].filter(record => targets.has(record.input.inputId));
    if (removable.length && !this.invalid) {
      const survivors = [...this.queued].filter(record => !targets.has(record.input.inputId));
      try {
        // No await may split clear from reinserting the exact surviving objects.
        this.session.clearQueue();
        for (const record of survivors) { if (record.input.mode === 'steer') this.originals.steer(record.message!); else this.originals.followUp(record.message!); }
        for (const record of removable) {
          this.queued.delete(record);
          const proof: Removal = { kind: 'removed', inputId: record.input.inputId, runId: this.callbacks.runId, at: new Date().toISOString() };
          record.removed = proof; this.removals.push(proof);
          if (this.callbacks.cancelled) this.save(`cancelled:${proof.inputId}`, () => this.callbacks.cancelled!(proof, proof.at));
        }
      } catch { for (const record of [...removable, ...survivors]) this.markUnknown(record, 'remove_unconfirmed'); }
    }
    for (const [inputId, request] of this.cancellations) {
      const record = this.records.get(inputId)!;
      const proof: InputCancelProof = record.entryId ? { kind: 'consumed', inputId, runId: this.callbacks.runId, nativeEntryId: record.entryId }
        : record.removed ?? { kind: 'unknown', inputId, error: safeError('input_delivery_unknown') };
      request.resolve(proof); this.cancellations.delete(inputId);
    }
  }
  async close(runId: number, _outcome: 'completed' | 'failed' | 'cancelled'): Promise<InputSettlementProof> {
    if (runId !== this.callbacks.runId) throw safeError('state_conflict');
    this.closeAdmission();
    await this.preflight; await Promise.all([...this.longTasks]); await this.session.waitForIdle();
    await this.serial(() => {
      if (!this.session.isIdle) { this.block(); return; }
      this.applyCancellations(true);
      if (this.invalid) { this.session.clearQueue(); }
    });
    const unconfirmedInputIds = [...this.records.values()].filter(record => record.unknown || record.started && !record.entryId || record.message && !record.started && !record.removed && !record.failed).map(record => record.input.inputId);
    return { runId, admissionClosed: !this.accepting, preflightSettled: true, nativeIdle: this.session.isIdle, nativeQueuesEmpty: !this.session.agent.hasQueuedMessages(), pendingPersistence: this.persistencePending(runId), removals: [...this.removals], unconfirmedInputIds };
  }
  persistencePending(runId: number): boolean { return runId === this.callbacks.runId && this.pendingSaves.size > 0; }
  retryPersistence(runId: number): void { if (runId !== this.callbacks.runId) return; for (const [key, operation] of [...this.pendingSaves]) this.save(key, operation); }
  dispose() {
    this.closeAdmission(); this.unsubscribe();
    const agent = this.session.agent;
    if (agent.prompt === this.installed.prompt) agent.prompt = this.originals.prompt;
    if (agent.steer === this.installed.steer) agent.steer = this.originals.steer;
    if (agent.followUp === this.installed.followUp) agent.followUp = this.originals.followUp;
    if (this.manager.appendMessage === this.installed.append) this.manager.appendMessage = this.originals.append;
    if (this.session.prompt === this.sessionInstalled.prompt) this.session.prompt = this.sessionOriginals.prompt;
    if (this.session.steer === this.sessionInstalled.steer) this.session.steer = this.sessionOriginals.steer;
    if (this.session.followUp === this.sessionInstalled.followUp) this.session.followUp = this.sessionOriginals.followUp;
  }
}
