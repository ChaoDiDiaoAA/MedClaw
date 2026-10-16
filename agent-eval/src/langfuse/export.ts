import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readReport, writeJsonExclusive } from '../reports/write.ts';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { evidencePath,replaceJson } from '../reports/write.ts';
import { acquireEvaluationWriteLock } from '../reports/write-lock.ts';
import { mapReport, assertSafeExport, type ExportEnvelope, type ExportEvent } from './map.ts';

export interface PlatformConfig { baseUrl: string; publicKey: string; secretKey: string; serverVersion: string; transport: 'otel-http-json/v1' }
export interface ExportReceipt { eventId: string; state: 'accepted' | 'rejected' | 'unknown'; receivedAt: string | null; safeError: string | null }
export interface ExportState { state: 'disabled' | 'complete' | 'error'; receipts: ExportReceipt[]; attempts: { at: string; state: string; receipts: ExportReceipt[] }[] }
export class PlatformReceiptSaveError extends Error {
  readonly retrySave: () => Promise<void>;
  constructor(save: () => Promise<void>) {
    super('storage_write_failed');
    let pendingRecovery: (() => Promise<void>) | undefined;
    this.retrySave = async () => {
      await pendingRecovery?.(); pendingRecovery = undefined;
      try { await save(); }
      catch (error) { if (error instanceof PlatformReceiptSaveError) pendingRecovery = error.retrySave; throw error; }
    };
  }
}
const pinnedRelease=(value:string|undefined)=>Boolean(value?.trim()&&!/replace|placeholder|^latest$/i.test(value.trim()));
export function platformConfig(env: Record<string, string | undefined> = process.env): PlatformConfig {
  const baseUrl = env.LANGFUSE_BASE_URL, publicKey = env.LANGFUSE_PUBLIC_KEY, secretKey = env.LANGFUSE_SECRET_KEY, serverVersion = env.MEDCLAW_LANGFUSE_SERVER_VERSION;
  if (!baseUrl || !publicKey || !secretKey || !serverVersion) throw new Error('langfuse_config_incomplete');
  if(!pinnedRelease(serverVersion))throw new Error('langfuse_version_unpinned');
  const config:PlatformConfig={ baseUrl, publicKey, secretKey, serverVersion, transport: 'otel-http-json/v1' };
  validatePlatformConfig(config);return config;
}
export function validatePlatformConfig(config:PlatformConfig):URL {
  if(!pinnedRelease(config.serverVersion)||config.transport!=='otel-http-json/v1')throw new Error('langfuse_version_unpinned');
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('langfuse_url_invalid');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('langfuse_https_required');
  return url;
}
export async function platformRequest(config: PlatformConfig, path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const url=validatePlatformConfig(config);
  const response = await fetch(new URL(path, url), { method, redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`, 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`langfuse_http_${response.status}`);
  try { return await response.json(); } catch { throw new Error('langfuse_response_invalid'); }
}
async function sendEvent(event: ExportEvent, config: PlatformConfig, signal?: AbortSignal): Promise<ExportReceipt> {
  try {
    const result = await platformRequest(config, event.kind === 'span' ? '/api/public/otel/v1/traces' : '/api/public/scores', 'POST', event.payload, signal);
    const score = z.object({ id: z.string().min(1) });
    const spans = z.strictObject({ partialSuccess: z.strictObject({ rejectedSpans: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(), errorMessage: z.string().optional() }).optional() });
    const parsed = (event.kind === 'score' ? score : spans).safeParse(result);
    if (!parsed.success) throw new Error('langfuse_response_invalid');
    const accepted = event.kind === 'score' ? score.parse(result).id === event.objectId : Number(spans.parse(result).partialSuccess?.rejectedSpans ?? 0) === 0;
    return { eventId: event.id, state: accepted ? 'accepted' : 'rejected', receivedAt: new Date().toISOString(), safeError: accepted ? null : 'langfuse_receipt_rejected' };
  } catch (error) {
    const safeError = error instanceof Error && /^langfuse_[a-z0-9_]+$/.test(error.message) ? error.message : 'langfuse_transport_failed';
    return { eventId: event.id, state: 'unknown', receivedAt: null, safeError };
  }
}
export interface ExportDocument {contract:'medclaw-export-state/v1';envelope:ExportEnvelope;binding:unknown;state:ExportState;review?:{queues:Record<string,unknown>;receipts:unknown[]}}
export async function inspectExport(path:string):Promise<{root:string;document:ExportDocument;persisted:boolean}> {
  const report=await readReport(path),root=path.endsWith('.json')?dirname(resolve(path)):resolve(path),observations:Record<string,any>={};
  for(const trial of report.trials)if(trial.observationRef)observations[trial.trialId]=JSON.parse(await readFile(await evidencePath(root,trial.observationRef),'utf8'));
  const binding={report:JSON.parse(JSON.stringify(report)),snapshot:report.snapshot};
  let document:ExportDocument,persisted=true;
  try{document=JSON.parse(await readFile(await evidencePath(root,'export.json'),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;persisted=false;document={contract:'medclaw-export-state/v1',envelope:mapReport(report,observations),binding,state:{state:'disabled',receipts:[],attempts:[]}};}
  if(document.contract!=='medclaw-export-state/v1'||!isDeepStrictEqual(document.binding,binding)||!isDeepStrictEqual(document.envelope,mapReport(report,observations,document.envelope.identities)))throw new Error('export_envelope_mismatch');
  assertSafeExport(document.envelope);
  return {root,document,persisted};
}
export async function ensureExport(path:string):Promise<{root:string;document:ExportDocument}> {
  const {root,document,persisted}=await inspectExport(path);
  if(!persisted)await writeJsonExclusive(join(root,'export.json'),document);
  return {root,document};
}
export async function exportReport(path:string,backend:'local'|'langfuse',config?:PlatformConfig,signal?:AbortSignal):Promise<ExportState> {
  if(backend==='local'){await readReport(path);return {state:'disabled',receipts:[],attempts:[]};}
  config??=platformConfig();
  validatePlatformConfig(config);
  const report=await readReport(path);if(!report.trials.some(trial=>trial.startedAt))throw new Error('export_no_started_trials');
  signal?.throwIfAborted();
  const root=path.endsWith('.json')?dirname(resolve(path)):resolve(path),release=await acquireEvaluationWriteLock(root,'export');
  let pendingSave:PlatformReceiptSaveError|undefined;
  try {
    const {document}=await ensureExport(path),receipts=new Map(document.state.receipts.map(receipt=>[receipt.eventId,receipt]));
    const attempt={at:new Date().toISOString(),state:'error',receipts:[] as ExportReceipt[]};let started=false;
    const update=()=>{
      const state=document.envelope.events.every(event=>receipts.get(event.id)?.state==='accepted')?'complete':'error';
      document.state.state=state;document.state.receipts=document.envelope.events.flatMap(event=>receipts.has(event.id)?[receipts.get(event.id)!]:[]);attempt.state=state;
    };
    for(const event of document.envelope.events) {
      if(receipts.get(event.id)?.state==='accepted')continue;
      if(signal?.aborted)break;
      if(!started){document.state.attempts.push(attempt);started=true;}
      const pending:ExportReceipt={eventId:event.id,state:'unknown',receivedAt:null,safeError:'langfuse_delivery_unconfirmed'};
      receipts.set(event.id,pending);attempt.receipts.push(pending);update();
      try{await replaceJson(join(root,'export.json'),document);}catch(cause){throw new Error('storage_write_failed',{cause});}
      const beforeResponse=structuredClone(document.state),receipt=await sendEvent(event,config,signal);
      receipts.set(event.id,receipt);attempt.receipts[attempt.receipts.length-1]=receipt;update();
      try{await replaceJson(join(root,'export.json'),document);}
      catch {
        throw new PlatformReceiptSaveError(async()=>{
          const releaseRecovery=await acquireEvaluationWriteLock(root,'export');
          try {
            await evidencePath(root,'export.json');
            const current=(await inspectExport(path)).document;
            if(!isDeepStrictEqual(current.binding,document.binding)||!isDeepStrictEqual(current.envelope,document.envelope))throw new Error('state_conflict');
            if(isDeepStrictEqual(current.state,document.state))return;
            if(!isDeepStrictEqual(current.state,beforeResponse))throw new Error('state_conflict');
            await replaceJson(join(root,'export.json'),document);
          }finally{try{await releaseRecovery();}catch{throw new PlatformReceiptSaveError(releaseRecovery);}}
        });
      }
    }
    return document.state;
  } catch(error) {if(error instanceof PlatformReceiptSaveError)pendingSave=error;throw error;}
  finally {
    try{await release();}
    catch{const save=pendingSave?.retrySave;throw new PlatformReceiptSaveError(async()=>{await release();await save?.();});}
  }
}
