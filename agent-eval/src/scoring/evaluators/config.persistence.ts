import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "config.persistence", name: "config.persistence", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；凭据失败、配置失败、响应丢失及正常保存机会",
  evaluate: (expected, actual, check, context) => native("config.persistence", expected, actual, check),
} satisfies EvaluatorDefinition;
