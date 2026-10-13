import { intentStageScore } from '../intent.ts';
import type { EvaluatorDefinition } from '../types.ts';
export default {
  id: "intent.route_exact", name: "intent_route_exact", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "补全设计身份；[01§8.6.1](01_MedClaw_Agent评测总方案_v1.md#eval01-8-6-1)；程序采用的条件/计划/允许路由正确的任务/适用任务",
  evaluate: (expected, actual, check) => intentStageScore(expected, actual, check),
} satisfies EvaluatorDefinition;
