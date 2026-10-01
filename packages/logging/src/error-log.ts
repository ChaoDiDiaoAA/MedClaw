import { safeError } from "../../contracts/src/error";
import { DiagnosticsEntrySchema, type DiagnosticsEntry } from "../../contracts/src/protocol";

export type LogSource = "main" | "host";
export type LogContext = { at?: string; operationRef?: string; runId?: number; instanceId?: string; inputChars?: number; outputChars?: number };
export function safeLogContext(context: LogContext = {}) {
  const at = DiagnosticsEntrySchema.shape.at.safeParse(context.at);
  const operationRef = DiagnosticsEntrySchema.shape.operationRef.safeParse(context.operationRef);
  const runId = DiagnosticsEntrySchema.shape.runId.safeParse(context.runId);
  return { at: at.success && at.data ? at.data : new Date().toISOString(),
    ...(operationRef.success && operationRef.data ? { operationRef: operationRef.data } : {}),
    ...(runId.success && runId.data ? { runId: runId.data } : {}) };
}
export class ErrorLog {
  private entries: DiagnosticsEntry[] = [];
  constructor(private readonly source: LogSource = "host") {}
  add(value: unknown, context: LogContext = {}) {
    const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : "internal_error";
    const safe = safeLogContext(context);
    const error = safeError(code, value, safe);
    this.entries.push({ category: "errors", source: this.source, ...safe, message: error.message, error });
    if (this.entries.length > 50) this.entries.shift();
  }
  read() { return structuredClone(this.entries); }
}
