import type { EvaluatorDefinition } from '../types.ts';
import { unknown } from '../rules.ts';
export default {
  id: "answer.faithful", name: "answer.faithful", version: 'v1', kind: 'llm-judge', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；无超证据事实且口径完整任务/回答任务",
  evaluate: (expected, actual, check, context) => unknown('Semantic answer assessment requires the independent Judge channel orchestrated by evaluate'),
} satisfies EvaluatorDefinition;
