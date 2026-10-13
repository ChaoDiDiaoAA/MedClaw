import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "tool.params", name: "tool.params", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新口径）；旧行为兼容", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[新行为定义](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；[原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)保留：准备后参数及依赖语义正确机会/全部应执行机会；版本/checkId/scope区分，不重复计权",
  evaluate: (expected, actual, check, context) => behavior("tool.params", expected, actual, check),
} satisfies EvaluatorDefinition;
