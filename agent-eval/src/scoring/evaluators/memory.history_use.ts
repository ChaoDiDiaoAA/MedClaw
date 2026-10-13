import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "memory.history_use", name: "memory.history_use", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；历史信息使用率：正确使用有效历史要求点/应使用点 ↑",
  evaluate: (expected, actual, check, context) => behavior("memory.history_use", expected, actual, check),
} satisfies EvaluatorDefinition;
