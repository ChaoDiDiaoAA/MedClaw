import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "tool.once", name: "tool.once", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；一次execute、合法准入拒绝或原身份查回/真实原生call",
  evaluate: (expected, actual, check, context) => native("tool.once", expected, actual, check),
} satisfies EvaluatorDefinition;
