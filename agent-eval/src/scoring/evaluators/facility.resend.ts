import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "facility.resend", name: "facility.resend", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；零模型重跑且幂等/补传机会。Schema/隔离/清理/评分自检必须全满足",
  evaluate: (expected, actual, check, context) => native("facility.resend", expected, actual, check),
} satisfies EvaluatorDefinition;
