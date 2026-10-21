---
name: device-identity-resolve
description: Resolve device candidates and distinguish a unique match, ambiguity and no match without inventing an identity
---
# Resolve a device identity

## Workflow

1. Call `read_data_scope` and preserve the current permitted scope and workspace identities.
2. Read `references/identity-matching.md` when choosing matching criteria or resolving multiple candidates.
3. Call `resolve_device` with the actual search `text` and an appropriate `matchBy` of `name`, `source_id` or `submission_id`. Inspect all relevant pages and the returned `resolution`.
4. For a unique confirmed candidate, call `read_device` with its returned `deviceId`. If several plausible candidates remain, present distinguishing fields and ask the user to select.
5. Return the actual identity fields and device ID, the matching basis and remaining ambiguity. A none result means no match in accessible data, not that the device does not exist.

## Boundaries

Do not treat a device name, source ID or submission ID as interchangeable. Resolving identity does not establish current price, stock or legal authorization.

Skill text is guidance. Product scope checks and existing tool permissions remain authoritative. If a needed capability is unavailable, report it; do not install tools, execute scripts or widen scope. Loading this Skill or delivering its text does not prove that the model followed it or completed the business task.
