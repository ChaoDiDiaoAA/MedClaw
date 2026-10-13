import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "context.current_use", name: "context.current_use", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；当前事实使用率：正确使用当前事实要求点/应使用点 ↑",
  evaluate: (expected, actual, check, context) => behavior("context.current_use", expected, actual, check),
} satisfies EvaluatorDefinition;
