import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "context.necessary_coverage", name: "context.necessary_coverage", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；必要信息覆盖率：实际请求内必要可用事实点/应提供事实点 ↑",
  evaluate: (expected, actual, check, context) => behavior("context.necessary_coverage", expected, actual, check),
} satisfies EvaluatorDefinition;
