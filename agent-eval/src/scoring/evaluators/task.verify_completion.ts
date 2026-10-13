import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "task.verify_completion", name: "task.verify_completion", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；完成核验正确率：终结状态及目标判断正确机会/应验终结机会 ↑",
  evaluate: (expected, actual, check, context) => behavior("task.verify_completion", expected, actual, check),
} satisfies EvaluatorDefinition;
