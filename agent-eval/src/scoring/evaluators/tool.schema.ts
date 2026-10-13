import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "tool.schema", name: "tool.schema", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；实际Schema应拒绝的非法输入正确拒绝机会/全部适用非法机会",
  evaluate: (expected, actual, check, context) => native("tool.schema", expected, actual, check),
} satisfies EvaluatorDefinition;
