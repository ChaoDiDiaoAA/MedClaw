import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "tool.redundancy", name: "tool.redundancy", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；冗余工具比例：无新信息且无依据的调用/实际工具调用 ↓",
  evaluate: (expected, actual, check, context) => behavior("tool.redundancy", expected, actual, check),
} satisfies EvaluatorDefinition;
