import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "loop.termination", name: "loop.termination", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；满足适用终态、真实停止、必要收尾及准入约束的Run/全部应终止Run",
  evaluate: (expected, actual, check, context) => native("loop.termination", expected, actual, check),
} satisfies EvaluatorDefinition;
