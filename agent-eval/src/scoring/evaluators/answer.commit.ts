import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "answer.commit", name: "answer.commit", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；所有最终回合收口机会，按当期适用对象一致提交或正确失败/全部机会；P9交付收口，P14加入条件，P15完整业务验证",
  evaluate: (expected, actual, check, context) => native("answer.commit", expected, actual, check),
} satisfies EvaluatorDefinition;
