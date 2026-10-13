import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "provider.identity", name: "provider.identity", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；实际配置一致请求/全部请求",
  evaluate: (expected, actual, check, context) => native("provider.identity", expected, actual, check),
} satisfies EvaluatorDefinition;
