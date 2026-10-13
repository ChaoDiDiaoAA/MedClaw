import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "subagent.identity_scope", name: "subagent.identity_scope", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；父子身份及范围符合率：首请求前关联及子范围正确链/应验链 ↑",
  evaluate: (expected, actual, check, context) => behavior("subagent.identity_scope", expected, actual, check),
} satisfies EvaluatorDefinition;
