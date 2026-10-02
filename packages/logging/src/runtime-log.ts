import { safeError } from "../../contracts/src/error";
import type { DiagnosticsEntry } from "../../contracts/src/protocol";
import { safeLogContext, type LogContext, type LogSource } from "./error-log";

const stages: Record<string, string> = {
  host_start: "Host starting", host_ready: "Host ready", host_stop: "Host stopping", host_stopped: "Host exited", host_failure: "Host failure",
  request_received: "Operation received", run_started: "Run started", call_started: "Model call started", call_finished: "Model call ended",
  run_stopped: "Execution stopped", run_saved: "Run facts saved", config_published: "Configuration published", catalog_refresh: "Refreshing model directory",
  auth_started: "Authentication started", auth_finished: "Authentication ended", preview_dropped: "Temporary preview merged or omitted",
  "provider.preview": "Temporary preview updated", "provider.settled": "Run saved", "provider.persistence_failed": "Run facts are not saved yet",
};
export function safeStageMessage(message: string, context: LogContext = {}) {
  const label = Object.hasOwn(stages, message) ? stages[message]! : "Diagnostic content omitted";
  const lengths = ["inputChars", "outputChars"] as const;
  return (label + lengths.flatMap(key => Number.isSafeInteger(context[key]) && context[key]! >= 0 ? [` ${key}=${context[key]}`] : []).join("")).slice(0, 2000);
}
export class RuntimeLog {
  private entries: DiagnosticsEntry[] = [];
  private stderr = "";
  constructor(private readonly source: LogSource = "host") {}
  add(message: string, context: LogContext = {}) {
    this.entries.push({ category: "runtime", source: this.source, ...safeLogContext(context), message: safeStageMessage(message, context) });
    if (this.entries.length > 200) this.entries.shift();
  }
  addStderr(raw: string) {
    const code = raw.trim();
    const error = safeError(code);
    const message = error.code === "internal_error" ? `Host diagnostic output omitted (${raw.length} characters)` : error.message;
    this.stderr = `${this.stderr}${message}\n`.slice(-6000);
    this.add("host_failure");
  }
  stderrTail() { return this.stderr; }
  read() { return structuredClone(this.entries); }
}
