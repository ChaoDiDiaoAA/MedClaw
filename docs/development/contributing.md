# Development and contributing

[简体中文](contributing.zh-CN.md) · [Documentation index](../README.md)

## Workspace and prerequisites

Use Windows x64, Bun `1.4.0` and Node.js 24 for the current development path. The managed subagent dependency patch is tracked; keep it with the lockfile as explained in [getting started](../guides/getting-started.md). An already populated dependency directory is not proof of clean-install readiness.

| Area | Responsibility |
| --- | --- |
| `apps/desktop`, `apps/host` | Electron boundary, controlled Host and maintenance |
| `packages/contracts`, `packages/core` | Shared schemas, application and domain behavior |
| `packages/runtime-pi`, `packages/intent-ollama` | Main Agent integration and the separate local intent client |
| `packages/storage`, `packages/logging` | Persistence, migrations and diagnostic projections |
| `resources` | Product prompts, Skills, subagent roles/templates and trusted extensions |
| `agent-eval`, `tests` | Independent evaluation and engineering verification |

Read [architecture](../architecture/overview.md) and [intent recognition](../intent/overview.md) before changing their boundaries. Public behavior used by authoring checks lives in [behavior contracts](../architecture/behavior-contracts.md).

## Existing commands

Run commands from the repository root; [package.json](../../package.json) is the command source of truth.

| Command | Purpose |
| --- | --- |
| `bun run dev:desktop` | Prepare development resources and launch the desktop |
| `bun run typecheck` | Workspace TypeScript checks |
| `bun run test:unit -- --stage P13` | Unit tests for a selected stage |
| `bun run test:integration -- --stage P13` | Integration tests for a selected stage |
| `bun run test:e2e -- --stage P13` | Terminal product/Host workflow checks for a stage |
| `bun run test:e2e:desktop -- --stage P13` | Electron desktop interaction checks for a stage |
| `bun run test:eval` | Evaluation infrastructure tests |
| `bun run build:desktop` | Prepare desktop and bundled production resources |
| `bun run package:desktop` | Build the Windows x64 installer |

`P13` is an example: choose `P1` through `P17` for the behavior being changed. Unit and integration commands require `--stage`; omitting it returns Usage without running tests. Terminal e2e and desktop commands default to all their discovered stages when no stage is given. Their optional `--check` lists selected files and checks runner availability without executing tests, for example `bun run test:e2e:desktop -- --stage P13 --check`. This preflight does not certify app or model readiness. See [the runner](../../tests/run.ts).

Select verification that exercises the changed behavior, including affected callers, persisted state and cancellation paths. Separate deterministic fixtures from real-service checks. Inspect prerequisites before end-to-end or model-evaluation runs; configured external requests may incur cost and transmit task material. See [evaluation](../evaluation/overview.md).

## Documentation and data changes

Public topic pages use English `.md` and Chinese `.zh-CN.md` companions, with reciprocal language links and an entry in [the index](../README.md). Update both versions and actual command/source links. Describe implemented behavior separately from unverified model quality or planned capability.

The five local planning/material directories are intentionally ignored. Public docs and dataset authoring checks must work without them. When moving a public source section used by an evaluation case, update its source reference and verification record through the existing checks; do not silently certify changed Case, Gold or scoring content.

Never include real credentials, private data roots or raw local run materials in a contribution. A useful issue or change description states the trigger, expected and actual result, redacted error, affected scope and verification performed. UI changes should include focused visual and interaction evidence rather than an unsupported claim that all screens passed.
