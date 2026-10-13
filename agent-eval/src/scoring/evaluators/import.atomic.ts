import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "import.atomic", name: "import.atomic", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；原子合法导入或正确拒绝/导入机会",
  evaluate: (expected, actual, check, context) => native("import.atomic", expected, actual, check),
} satisfies EvaluatorDefinition;
