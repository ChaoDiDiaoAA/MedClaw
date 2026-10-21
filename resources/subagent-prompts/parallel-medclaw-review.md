---
description: Delegate complementary MedClaw evidence reviews in parallel
---
For the following task, call the Agent tool twice in the same turn with distinct tasks: ask "medclaw-audit" to verify the authorized evidence, and ask "general-analyst" to independently analyze the task materials you explicitly provide. Both tasks are foreground and read-only. The general analyst has no tools. Reconcile their results and limitations before answering. You retain responsibility for authorized intent steps, QueryContext, and final submission. Do not create more than four owned children or silently substitute roles.

Task:
$ARGUMENTS
