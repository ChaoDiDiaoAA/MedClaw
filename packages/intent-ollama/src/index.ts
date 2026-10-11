import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppErrorSchema, safeError, type AppError } from '@medclaw/contracts/error';
import { IntentModelConfigurationSchema, IntentModelSelectionSchema, INTENT_VERSIONS,
  type IntentModelConfiguration, type IntentModelSelection } from '@medclaw/contracts/model';
import { CONTEXT_MATERIAL_PREFIX, renderIntentContext } from '@medclaw/contracts/context';
import { canonicalRequest } from '@medclaw/contracts/run';
import { IntentStageInputSchema, IntentHttpOutcomeSchema, IntentModelInspectionSchema, INTENT_STAGE_INPUT_BYTES, intentJsonSchema,
  type IntentModelClient, type IntentStageInput, type IntentHttpObservation, type IntentHttpOutcome } from '@medclaw/contracts/intent';

const ENVELOPE_BYTES = 1024 * 1024, CONTENT_BYTES = 64 * 1024;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const label = z.string().min(1).max(256), count = z.number().int().nonnegative().safe();
const tagSchema = z.object({ name: label, digest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/), model: label.optional() });
const tagsSchema = z.object({ models: z.array(tagSchema).max(10000) });
const envelopeSchema = z.object({ model: label, done: z.boolean(), done_reason: label.nullable().optional(),
  message: z.object({ role: z.literal('assistant'), content: z.string() }),
  prompt_eval_count: z.unknown().optional(), eval_count: z.unknown().optional(), total_duration: z.unknown().optional() });
const normalizeTag = (name: string) => name.toLowerCase().replace(/^library\//, '');
function fail(code: string): never { throw new Error(code); }
function checked<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value); return result.success ? result.data : fail(code);
}
function safeFailure(error: unknown): AppError {
  const parsed = AppErrorSchema.safeParse(error); if (parsed.success) return parsed.data;
  if (error instanceof Error && 'code' in error && error.code === 'UnexpectedRedirect') return safeError('intent_response_invalid');
  const known = safeError(error instanceof Error ? error.message : 'intent_offline');
  return known.code === 'internal_error' ? safeError('intent_offline') : known;
}
async function readJson(response: Response): Promise<unknown> {
  const oversize = () => Object.assign(new Error('intent_response_invalid'), { oversized: true });
  if (Number(response.headers.get('content-length')) > ENVELOPE_BYTES) throw oversize();
  if (!response.body) fail('intent_response_invalid');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > ENVELOPE_BYTES) throw oversize(); chunks.push(part.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { fail('intent_response_invalid'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function request(baseUrl: string, path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
  signal.throwIfAborted();
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { method: body === undefined ? 'GET' : 'POST', signal,
    redirect: 'error', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error('intent_response_invalid'), { httpStatus: response.status });
  }
  return response;
}
async function readTag(baseUrl: string, modelTag: string, signal: AbortSignal) {
  const tags = checked(tagsSchema, await readJson(await request(baseUrl, '/api/tags', signal)), 'intent_response_invalid');
  const matches = tags.models.filter(tag => normalizeTag(tag.name) === normalizeTag(modelTag));
  if (!matches.length) fail('intent_model_unavailable');
  if (matches.length !== 1 || matches[0]!.model !== undefined && normalizeTag(matches[0]!.model!) !== normalizeTag(modelTag)) fail('intent_model_identity_mismatch');
  return 'sha256:' + matches[0]!.digest.replace(/^sha256:/, '');
}
async function delivered(action: Promise<void>, signal: AbortSignal): Promise<void> {
  let abort!: () => void;
  try { await Promise.race([action, new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  })]); } finally { signal.removeEventListener('abort', abort); }
}

export class OllamaIntentClient implements IntentModelClient {
  readonly prompts: Readonly<Record<'classify' | 'verify', Readonly<{ text: string; hash: string; version: string }>>>;
  constructor(prompts: { classify: string; verify: string }) {
    for (const text of [prompts.classify, prompts.verify]) if (typeof text !== 'string' || !text.trim()) fail('invalid_argument');
    this.prompts = Object.freeze({ classify: Object.freeze({ text: prompts.classify, hash: hash(prompts.classify), version: INTENT_VERSIONS.classifyPromptVersion }),
      verify: Object.freeze({ text: prompts.verify, hash: hash(prompts.verify), version: INTENT_VERSIONS.verifyPromptVersion }) });
  }
  async inspect(raw: IntentModelConfiguration, external = new AbortController().signal) {
    let actualDigest: string | null = null, metadata = null, signal = external;
    try {
      const config = checked(IntentModelConfigurationSchema, raw, 'invalid_argument');
      signal = AbortSignal.any([external, AbortSignal.timeout(Math.min(config.timeoutMs, 5000))]);
      const version = checked(z.object({ version: label }), await readJson(await request(config.baseUrl, '/api/version', signal)), 'intent_response_invalid');
      actualDigest = await readTag(config.baseUrl, config.modelTag, signal);
      const show = checked(z.object({ details: z.object({ family: label.nullable().optional(), parameter_size: label.nullable().optional(),
        quantization_level: label.nullable().optional() }).optional() }), await readJson(await request(config.baseUrl, '/api/show', signal, { model: config.modelTag })), 'intent_response_invalid');
      metadata = { serviceVersion: version.version, family: show.details?.family ?? null, parameterSize: show.details?.parameter_size ?? null, quantization: show.details?.quantization_level ?? null };
      return IntentModelInspectionSchema.parse({ contract: 'medclaw.intent-model-inspection/v1', checkedAt: new Date().toISOString(), available: true, actualDigest, metadata, error: null });
    } catch (error) {
      const failed = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? safeError('intent_timeout') : safeFailure(error);
      return IntentModelInspectionSchema.parse({ contract: 'medclaw.intent-model-inspection/v1', checkedAt: new Date().toISOString(), available: false, actualDigest, metadata, error: failed });
    }
  }
  /** Runtime verifies the frozen digest before B1 registration; this method checks it again after the one POST. */
  async recognizeIntent(raw: IntentStageInput, rawSelection: IntentModelSelection, external: AbortSignal,
    onDelivered: (fact: IntentHttpObservation) => Promise<void>): Promise<IntentHttpOutcome> {
    const started = performance.now();
    const outcome: IntentHttpOutcome = { transportState: 'failed', rawOutput: null, rawOutputTruncated: false, responseModel: null, doneReason: null,
      httpStatus: null, observation: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0,
      inputTokens: null, outputTokens: null, serverTotalDurationNs: null, error: null };
    let signal = external, response: Response | undefined;
    try {
      external.throwIfAborted();
      const selection = checked(IntentModelSelectionSchema, rawSelection, 'invalid_argument'); if (!selection.enabled) fail('intent_model_unavailable');
      let encoded: string;
      try { encoded = canonicalRequest(raw); } catch { fail('invalid_argument'); }
      if (Buffer.byteLength(encoded) > INTENT_STAGE_INPUT_BYTES) fail('intent_input_too_large');
      const input = checked(IntentStageInputSchema, raw, 'invalid_argument'), projection = renderIntentContext(input);
      if (Buffer.byteLength(projection) > INTENT_STAGE_INPUT_BYTES + Buffer.byteLength(CONTEXT_MATERIAL_PREFIX)) fail('intent_input_too_large');
      signal = AbortSignal.any([external, AbortSignal.timeout(selection.timeoutMs)]);
      // Classification JSON repeats labels and keys; do not inherit creative-generation penalties.
      const body = { model: selection.modelTag, messages: [{ role: 'system', content: this.prompts[input.stage].text },
        { role: 'user', content: projection }], format: intentJsonSchema, think: false, stream: false, truncate: false,
        // The frozen taxonomy and bounded projection exceed Ollama's 4K default; never classify a truncated task.
        options: { num_ctx: 65536, temperature: 0, repeat_penalty: 1, presence_penalty: 0, frequency_penalty: 0 } };
      response = await request(selection.baseUrl, '/api/chat', signal, body); outcome.httpStatus = response.status;
      outcome.observation = { contract: 'medclaw.context-observation/v1', api: 'ollama-chat', transport: 'json', observedAt: new Date().toISOString(),
        httpStatus: response.status, payloadHash: hash(JSON.stringify(body)), projectionHash: hash(projection), feedbackHash: hash(''), verifiedNativeRefs: [] };
      await delivered(onDelivered(outcome.observation), signal); signal.throwIfAborted();
      const envelope = checked(envelopeSchema, await readJson(response), 'intent_response_invalid');
      outcome.responseModel = envelope.model; outcome.doneReason = envelope.done_reason ?? null;
      const content = Buffer.from(envelope.message.content, 'utf8');
      outcome.rawOutput = content.subarray(0, CONTENT_BYTES).toString('utf8');
      if (Buffer.byteLength(outcome.rawOutput) > CONTENT_BYTES) outcome.rawOutput = outcome.rawOutput.slice(0, -1);
      outcome.rawOutputTruncated = content.byteLength > CONTENT_BYTES || envelope.done_reason === 'length';
      const inputTokens = count.safeParse(envelope.prompt_eval_count), outputTokens = count.safeParse(envelope.eval_count), duration = count.safeParse(envelope.total_duration);
      outcome.inputTokens = inputTokens.success ? inputTokens.data : null; outcome.outputTokens = outputTokens.success ? outputTokens.data : null;
      outcome.serverTotalDurationNs = duration.success ? duration.data : null;
      if (normalizeTag(envelope.model) !== normalizeTag(selection.modelTag)) fail('intent_model_identity_mismatch');
      if (!envelope.done || outcome.rawOutputTruncated || [envelope.prompt_eval_count, envelope.eval_count, envelope.total_duration]
        .some(value => value !== undefined && value !== null && !count.safeParse(value).success)) fail('intent_response_invalid');
      let actualDigest: string;
      try { actualDigest = await readTag(selection.baseUrl, selection.modelTag, signal); }
      catch (error) { if (error instanceof Error && error.message === 'intent_model_unavailable') fail('intent_model_identity_mismatch'); throw error; }
      if (actualDigest !== selection.modelDigest) fail('intent_model_identity_mismatch');
      signal.throwIfAborted(); outcome.transportState = 'completed';
      try { const parsed = JSON.parse(outcome.rawOutput); if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('intent_output_invalid'); }
      catch { outcome.error = safeError('intent_output_invalid'); }
    } catch (error) {
      if (error instanceof Error && 'oversized' in error && error.oversized) outcome.rawOutputTruncated = true;
      if (outcome.httpStatus === null && error instanceof Error && 'httpStatus' in error && typeof error.httpStatus === 'number') outcome.httpStatus = error.httpStatus;
      if (signal.aborted) {
        if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') outcome.error = safeError('intent_timeout');
        else { outcome.transportState = 'cancelled'; const reason = AppErrorSchema.safeParse(signal.reason); outcome.error = reason.success ? reason.data : null; }
      } else outcome.error = safeFailure(error);
    } finally {
      await response?.body?.cancel().catch(() => {});
      outcome.endedAt = new Date().toISOString(); outcome.durationMs = performance.now() - started;
    }
    return IntentHttpOutcomeSchema.parse(outcome);
  }
}
