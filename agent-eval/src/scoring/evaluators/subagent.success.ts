import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "subagent.success", name: "subagent.success", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；子任务成功率：达成子目标执行/事前应执行子任务 ↑",
  evaluate: (expected, actual, check, context) => behavior("subagent.success", expected, actual, check),
} satisfies EvaluatorDefinition;
