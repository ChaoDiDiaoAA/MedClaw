import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "resource.progressive_read", name: "resource.progressive_read", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；渐进读取符合率：必要范围内按需读取的决策/应验读取决策 ↑",
  evaluate: (expected, actual, check, context) => behavior("resource.progressive_read", expected, actual, check),
} satisfies EvaluatorDefinition;
