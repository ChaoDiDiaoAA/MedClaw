import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "compaction.native", name: "compaction.native", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；原生压缩且保存/压缩机会",
  evaluate: (expected, actual, check, context) => native("compaction.native", expected, actual, check),
} satisfies EvaluatorDefinition;
