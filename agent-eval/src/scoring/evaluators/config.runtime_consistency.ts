import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "config.runtime_consistency", name: "config.runtime_consistency", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；实际调用符合该Run记录的配置版本/所有Run",
  evaluate: (expected, actual, check, context) => native("config.runtime_consistency", expected, actual, check),
} satisfies EvaluatorDefinition;
