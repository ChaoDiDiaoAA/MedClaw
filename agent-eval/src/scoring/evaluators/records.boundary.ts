import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "records.boundary", name: "records.boundary", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；正确保留/读取/隔离检查/八类适用检查",
  evaluate: (expected, actual, check, context) => native("records.boundary", expected, actual, check),
} satisfies EvaluatorDefinition;
