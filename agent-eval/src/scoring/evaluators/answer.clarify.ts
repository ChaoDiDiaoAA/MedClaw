import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "answer.clarify", name: "answer.clarify", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；缺槽先问且不错误执行机会/应澄清机会",
  evaluate: (expected, actual, check, context) => native("answer.clarify", expected, actual, check),
} satisfies EvaluatorDefinition;
