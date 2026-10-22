# UI system

[简体中文](ui-system.zh-CN.md) · [Documentation index](../README.md)

This page describes the current desktop UI rather than a proposed redesign. The implementation lives in [React renderer sources](../../apps/desktop/src/renderer) and [styles.css](../../apps/desktop/src/renderer/styles.css).

## Foundation and shell

The current style uses Segoe UI / Microsoft YaHei UI, a 14 px base, neutral surfaces, restrained borders and a rose accent. The stylesheet defines light and dark variable sets. Existing CSS variables include `--canvas`, `--surface`, `--muted`, `--line` and `--accent`; reuse them instead of introducing a parallel token set. Buttons have distinct primary, quiet, danger and disabled states. Keyboard focus uses a visible outline.

The shell contains a collapsible navigation column, a main workspace and an optional details panel. The main conversation remains the reading surface; detailed facts and advanced controls belong in their task surface, disclosure or details panel. Scrolling belongs to the relevant page or panel. Long labels, identifiers and errors must wrap without hiding required actions.

## Navigation and page patterns

| Area | Current surface |
| --- | --- |
| Chat | Sessions, message routing, model selection, input, execution state and child task cards |
| Data Workspace | Data roots, import preview, batch selection and deletion controls |
| Query History | Adopted conditions, saved results, basis and explicit export |
| Models | Provider/model configuration and the separate Intent model panel |
| Prompt | Prompt optimization, saved-result inspection, copying and insertion into a Chat draft |
| Skills | Searchable resource catalog, versions, declared requirements and readiness |
| Extensions | Read-only agent management and trusted extension controls |
| Evaluation | Independent evaluation controls and result inspection |
| Settings | Application settings, diagnostics and maintenance |

Use current UI labels in both documentation languages so that instructions are searchable in the product. The intent model setup and Chat's **Message routing** control are distinct; see [intent configuration](../intent/configuration.md).

Navigation groups are **Work** (Chat, Data Workspace, Query History), **Models & Resources** (Models, Prompt, Skills, Extensions) and **Quality** (Evaluation). **Settings** and Host status sit in the navigation footer. Pages group operations by task; Settings separates **General**, **Runtime**, **Backup and restore**, **Support** and the available **Business prompt** surface.

Catalog browsing and Session-bound configuration are separate states. Without a confirmed Session, a readable catalog does not enable Session selection, role edits or execution. Preserve the appropriate empty, unavailable and diagnostic views. The slash menu groups Skills, Subagents, Prompt Templates and Extension Commands; see [Prompt and Skills](../guides/prompts-and-skills.md). Child cards and recorded role details are described in [subagents](../agents/subagents.md).

## State and interaction rules

Loading, unavailable capability, valid empty results, failed requests, cancellation and unknown outcomes need different descriptions. A missing price is not zero; a stopped stream is not proof that persistence or process cleanup finished. Retain relevant errors and provide a concrete recovery action when supported.

Disable actions according to real product state, keep labels associated with controls, preserve keyboard focus and make destructive selections explicit. Renderer display state does not grant filesystem or Host authority; operations use the [Preload whitelist](../../apps/desktop/src/preload/index.ts).

## Focused visual verification

For an affected page, check normal, loading, empty, error, cancelled and disabled states; keyboard navigation; long content; window resizing and relevant Windows display scaling. Recheck the main/details layout and scroll ownership when adding controls. State the actual visual coverage rather than claiming every configuration was tested.
