import { DiagnosticsViewSchema, SupportDiagnosticsSchema, type DiagnosticsEntry, type DiagnosticsView } from "../../contracts/src/protocol";
import { safeError, type AppError } from '../../contracts/src/error';
import { basename } from 'node:path';
import { safeStageSummary } from './runtime-log';

export function composeDiagnostics(input: {
  host: DiagnosticsView["host"]; versions: DiagnosticsView["versions"]; hostAvailable: boolean;
  mainEntries: DiagnosticsEntry[]; hostEntries?: DiagnosticsEntry[];
  dependencies?: DiagnosticsView['dependencies'];
  categories?: ("versions" | "host" | "errors" | "runtime" | "prompt_trace")[];
}): DiagnosticsView {
  const categories = input.categories ?? ["versions", "host", "errors", "runtime"];
  return DiagnosticsViewSchema.parse({ partial: !input.hostAvailable, missingSources: input.hostAvailable ? [] : ["host"],
    ...(categories.includes('versions') && input.dependencies ? { dependencies: input.dependencies } : {}),
    versions: input.versions, host: input.host, entries: [...input.mainEntries, ...(input.hostEntries ?? [])].filter(entry => categories.includes(entry.category)).slice(-8300) });
}

export function supportDiagnostics(input: DiagnosticsView, categories: string[]) {
  const { dependencies, ...view } = DiagnosticsViewSchema.parse(input);
  const error = (value: AppError | null) => value ? safeError(value.code, undefined, { reason: value.reason, operationRef: value.operationRef, runId: value.runId, sessionId: value.sessionId }) : null;
  return SupportDiagnosticsSchema.parse({ ...view,
    host: { ...view.host, error: error(view.host.error), ...(view.host.shutdown ? { shutdown: { ...view.host.shutdown, error: error(view.host.shutdown.error) } } : {}) },
    ...(categories.includes('versions') && dependencies ? { dependencies: dependencies.map(({ path, ...dependency }) => ({ ...dependency, program: basename(path) })) } : {}),
    entries: view.entries.filter(entry => categories.includes(entry.category)).map(entry => {
      const safe = error(entry.error ?? null);
      return { ...entry, message: safe?.message ?? safeStageSummary(entry.message), ...(safe ? { error: safe } : {}) };
    }),
  });
}
