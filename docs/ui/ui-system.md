# UI system

[简体中文](ui-system.zh-CN.md) · [Documentation index](../README.md)

This page describes the current desktop UI rather than a proposed redesign. The implementation lives in [React renderer sources](../../apps/desktop/src/renderer) and [styles.css](../../apps/desktop/src/renderer/styles.css).

## Foundation and shell

The current style uses Segoe UI / Microsoft YaHei UI, a 14 px base, light warm surfaces, restrained borders and a red accent. Existing CSS variables include `--surface`, `--muted`, `--line` and `--accent`; reuse them instead of introducing a parallel token set. Buttons have distinct primary, quiet, danger and disabled states. Keyboard focus uses a visible outline.

The shell contains a collapsible navigation column, a main workspace and an optional details panel. Scrolling belongs to the relevant page or panel. Long labels, identifiers and errors must wrap without hiding required actions.

## Navigation and page patterns

| Area | Current surface |
| --- | --- |
| Chat | Sessions, message routing, model selection, input and execution state |
| Data Workspace | Data roots, import preview, batch selection and deletion controls |
| Query History | Adopted conditions, saved results, basis and explicit export |
| Models | Provider/model configuration and the separate Intent model panel |
| Prompt / Skills / Extensions | Product resource and extension management |
| Evaluation | Independent evaluation controls and result inspection |
| Settings | Application settings, diagnostics and maintenance |

Use current UI labels in both documentation languages so that instructions are searchable in the product. The intent model setup and Chat's **Message routing** control are distinct; see [intent configuration](../intent/configuration.md).

## State and interaction rules

Loading, unavailable capability, valid empty results, failed requests, cancellation and unknown outcomes need different descriptions. A missing price is not zero; a stopped stream is not proof that persistence or process cleanup finished. Retain relevant errors and provide a concrete recovery action when supported.

Disable actions according to real product state, keep labels associated with controls, preserve keyboard focus and make destructive selections explicit. Renderer display state does not grant filesystem or Host authority; operations use the [Preload whitelist](../../apps/desktop/src/preload/index.ts).

## Focused visual verification

For an affected page, check normal, loading, empty, error, cancelled and disabled states; keyboard navigation; long content; window resizing and relevant Windows display scaling. Recheck the main/details layout and scroll ownership when adding controls. State the actual visual coverage rather than claiming every configuration was tested.
