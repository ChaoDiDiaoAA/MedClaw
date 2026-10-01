import { DiagnosticsViewSchema, type DiagnosticsEntry, type DiagnosticsView } from "../../contracts/src/protocol";

export function composeDiagnostics(input: {
  host: DiagnosticsView["host"]; versions: DiagnosticsView["versions"]; hostAvailable: boolean;
  mainEntries: DiagnosticsEntry[]; hostEntries?: DiagnosticsEntry[];
  categories?: ("versions" | "host" | "errors" | "runtime" | "prompt_trace")[];
}): DiagnosticsView {
  const categories = input.categories ?? ["versions", "host", "errors", "runtime"];
  return DiagnosticsViewSchema.parse({ partial: !input.hostAvailable, missingSources: input.hostAvailable ? [] : ["host"],
    versions: input.versions, host: input.host, entries: [...input.mainEntries, ...(input.hostEntries ?? [])].filter(entry => categories.includes(entry.category)).slice(-8300) });
}
