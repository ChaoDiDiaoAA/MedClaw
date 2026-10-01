import { PositiveIdSchema } from "../../contracts/src/error";
import type { DiagnosticsEntry } from "../../contracts/src/protocol";
import { safeLogContext, type LogContext, type LogSource } from "./error-log";
import { safeStageMessage } from "./runtime-log";

export class PromptTrace {
  private readonly runs = new Map<number, DiagnosticsEntry[]>();
  private completed: number[] = [];
  constructor(private readonly source: LogSource = "host") {}
  add(runId: number, message: string, context: LogContext = {}) {
    PositiveIdSchema.parse(runId);
    const entries = this.runs.get(runId) ?? [];
    entries.push({ category: "prompt_trace", source: this.source, ...safeLogContext({ ...context, runId }), message: safeStageMessage(message, context) });
    if (entries.length > 200) entries.shift();
    this.runs.set(runId, entries);
  }
  finish(runId: number) {
    if (!this.runs.has(runId) || this.completed.includes(runId)) return;
    this.completed.push(runId);
    while (this.completed.length > 20) this.runs.delete(this.completed.shift()!);
  }
  runRead(runId: number) { return structuredClone(this.runs.get(runId) ?? []); }
  read() { return structuredClone([...this.runs.values()].flat()); }
}
