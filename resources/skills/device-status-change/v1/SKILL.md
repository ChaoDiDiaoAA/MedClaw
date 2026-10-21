---
name: device-status-change
description: Inspect recorded status field changes and their evidence without converting them to regulatory conclusions
---
# Review device status changes

## Workflow

1. Call `read_data_scope` for the current input and confirm the requested dates and scope.
2. Read `references/status-change-basis.md` before interpreting a status transition.
3. Check interval and predecessor coverage with `check_data_coverage` and `requirePredecessor: true`. Use `query_device_changes` with `changeKind: field_changed`, `changeField: status` and the permitted batch IDs.
4. Read further results with `read_query_page` for the same Query, retaining the actual old/new values and old/new batch identities.
5. Use `list_query_evidence` and `read_query_evidence` for relevant events. Report dated transitions, Query and Evidence IDs, coverage limits and any unknown value.

## Boundaries

An imported status transition is a data fact. It is not proof of approval, revoked registration, production status or clinical risk.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
