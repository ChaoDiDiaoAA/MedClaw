import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "import.order", name: "import.order", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；冲突/乱序拒绝且旧状态保留/边界导入",
  evaluate: (expected, actual, check, context) => native("import.order", expected, actual, check),
} satisfies EvaluatorDefinition;
