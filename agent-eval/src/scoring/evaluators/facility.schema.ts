import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "facility.schema", name: "facility.schema", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；合法资产接受且非法拒绝/正反夹具",
  evaluate: (expected, actual, check, context) => native("facility.schema", expected, actual, check),
} satisfies EvaluatorDefinition;
