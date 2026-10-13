import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "export.delivery", name: "export.delivery", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；所有应外部交付机会，copyState=verified且state=completed并内容正确/全部机会",
  evaluate: (expected, actual, check, context) => native("export.delivery", expected, actual, check),
} satisfies EvaluatorDefinition;
