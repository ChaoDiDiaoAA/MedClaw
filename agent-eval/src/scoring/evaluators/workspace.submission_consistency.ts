import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "workspace.submission_consistency", name: "workspace.submission_consistency", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；使用提交时对象/所有现场依赖输入",
  evaluate: (expected, actual, check, context) => native("workspace.submission_consistency", expected, actual, check),
} satisfies EvaluatorDefinition;
