import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "loop.native", name: "loop.native", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；经原生Loop完成尝试/需Agent路径尝试",
  evaluate: (expected, actual, check, context) => native("loop.native", expected, actual, check),
} satisfies EvaluatorDefinition;
