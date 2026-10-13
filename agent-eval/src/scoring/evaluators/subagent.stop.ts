import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "subagent.stop", name: "subagent.stop", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新口径）；原工程条件保留", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[新行为定义](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；[原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)保留：父取消后子确已停且必要子收尾正确处理/全部取消机会；版本/checkId/scope区分，不重复计权",
  evaluate: (expected, actual, check, context) => behavior("subagent.stop", expected, actual, check),
} satisfies EvaluatorDefinition;
