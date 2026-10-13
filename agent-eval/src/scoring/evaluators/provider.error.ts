import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "provider.error", name: "provider.error", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；如实分类且未隐式降级失败/注入失败",
  evaluate: (expected, actual, check, context) => native("provider.error", expected, actual, check),
} satisfies EvaluatorDefinition;
