import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "resource.discovery", name: "resource.discovery", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；正确发现/冲突拒绝资源/受控资源",
  evaluate: (expected, actual, check, context) => native("resource.discovery", expected, actual, check),
} satisfies EvaluatorDefinition;
