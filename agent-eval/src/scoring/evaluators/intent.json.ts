import { intentStageScore } from '../intent.ts';
import type { EvaluatorDefinition } from '../types.ts';
export default {
  id: "intent.json", name: "intent_json_validity", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "正式质量", formula: "补全设计身份；[01§8.6.1](01_MedClaw_Agent评测总方案_v1.md#eval01-8-6-1)；通过严格JSON/Schema的真实模型输出数/取得输出的意图调用数；传输失败另列",
  evaluate: (expected, actual, check) => intentStageScore(expected, actual, check),
} satisfies EvaluatorDefinition;
