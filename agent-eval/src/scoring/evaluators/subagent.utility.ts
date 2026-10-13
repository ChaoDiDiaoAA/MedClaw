import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "subagent.utility", name: "subagent.utility", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新口径）；旧行为兼容", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[新行为定义](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；[原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)保留：合理采用或质疑子结论任务/委派任务；版本/checkId/scope区分，不重复计权",
  evaluate: (expected, actual, check, context) => behavior("subagent.utility", expected, actual, check),
} satisfies EvaluatorDefinition;
