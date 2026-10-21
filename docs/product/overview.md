# Product overview

[简体中文](overview.zh-CN.md) · [Documentation index](../README.md)

MedClaw is a local desktop workbench for asking questions about structured medical-device data. Users import snapshots, choose a data scope, ask a question, inspect the adopted conditions and calculated results, and follow the saved evidence or export the original query result.

## Workflow and audience

Data analysts prepare and select snapshot packages. Reviewers inspect dates, units, source rows, and field origins. Contributors maintain the desktop application, controlled Host, query services, and independent evaluation facilities.

The main workflow is **import → select scope → ask or specify conditions → clarify when needed → inspect results and evidence → follow up or export**. Examples include filtering devices, counting by manufacturer, comparing two imported dates, and examining price trends. These are questions about the supplied data, not evidence of physical inventory or causes of price changes.

## Capabilities and limits

| Area | Implemented surface | Boundary |
| --- | --- | --- |
| Data | Snapshot preview, import, scope selection, and deletion | Requires a package accepted by the importer; business data is not bundled with source |
| Questions | Main Agent and a separate intent-routing mode | Model configuration and available tools determine what can run |
| Intent | Rules, local structured classification, optional review, validation, and query planning | A registered label does not establish an executable capability |
| Queries | Current records, changes, aggregation, trends, and saved evidence | Dates, population, currency, units, and coverage must be explicit |
| Sessions | Session operations, persisted native history, context, and compaction integration | A request receipt does not prove persistence or later model use |
| Evaluation | Independent execution, deterministic checks, Judge scoring, reports, and explicit platform sync | Engineering fixtures and dataset checks do not establish real model quality |
| Desktop maintenance | Windows packaging, controlled Host ownership, backup and restore surfaces | Clean installation and real-service behavior need their own verification |

See [intent recognition](../intent/overview.md) for supported and disabled task families, [data import](../guides/data-import.md) for the accepted input, and [evaluation](../evaluation/overview.md) for evidence boundaries.

## Local storage and external processing

Business data, sessions, and run records are stored locally. A configured external model receives the text, context, and tool results required for its requests. An independent Judge and explicitly requested platform synchronization have separate data flows. Local-first storage does not mean every model request stays on the device.

The Electron Main process protects stored credentials with `safeStorage`; the renderer uses a whitelist bridge. Review exported or diagnostic material before sharing because raw execution originals may contain requests and results.

## Current readiness

The local intent model is fixed to the official `qwen3.5:0.8b`. Metadata inspection and engineering tests do not certify its semantic accuracy. Some taxonomy entries remain disabled because data or execution adapters are missing. The declared subagent dependency patch is currently absent from the tracked source, so clean dependency installation and packaging cannot be claimed to work without that prerequisite.

Read [getting started](../guides/getting-started.md), [architecture](../architecture/overview.md), and [Windows packaging](../release/windows-packaging.md) before selecting a deployment or verification path. This page reports capabilities and limits, not a completed release acceptance.
