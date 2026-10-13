import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "storage.commit", name: "storage.commit", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；应同事务事实一致/全部适用提交机会",
  evaluate: (expected, actual, check, context) => native("storage.commit", expected, actual, check),
} satisfies EvaluatorDefinition;
