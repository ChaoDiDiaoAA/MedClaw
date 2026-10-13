import type { EvaluatorDefinition } from '../types.ts';
import { keyedRule } from '../rules.ts';
export default {
  id: "diff.exact", name: "diff.exact", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；正确事件键/旧新值/类型/全部期望与预测事件",
  evaluate: (expected, actual, check, context) => keyedRule(expected, actual, check, "key", ["type","old","new"], false),
} satisfies EvaluatorDefinition;
