import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "config.rollback", name: "config.rollback", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；所有预定显式旧版本选择机会，兼容核验与新版本发布正确/全部机会",
  evaluate: (expected, actual, check, context) => native("config.rollback", expected, actual, check),
} satisfies EvaluatorDefinition;
