import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "task.clarify_decision", name: "task.clarify_decision", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；澄清决策正确率：正确继续、取证、求助或停止决策/应验决策点 ↑",
  evaluate: (expected, actual, check, context) => behavior("task.clarify_decision", expected, actual, check),
} satisfies EvaluatorDefinition;
