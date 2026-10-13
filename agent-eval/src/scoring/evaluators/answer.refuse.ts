import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "answer.refuse", name: "answer.refuse", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；域外正确拒绝/域外任务；另报合法误拒率",
  evaluate: (expected, actual, check, context) => native("answer.refuse", expected, actual, check),
} satisfies EvaluatorDefinition;
