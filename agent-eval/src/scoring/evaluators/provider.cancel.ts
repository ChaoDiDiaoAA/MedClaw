import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "provider.cancel", name: "provider.cancel", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；实际停止且无后续请求取消/所有取消",
  evaluate: (expected, actual, check, context) => native("provider.cancel", expected, actual, check),
} satisfies EvaluatorDefinition;
