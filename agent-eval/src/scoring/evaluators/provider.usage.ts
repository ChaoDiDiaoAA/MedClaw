import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "provider.usage", name: "provider.usage", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；有可信完整usage请求/全部计费请求",
  evaluate: (expected, actual, check, context) => native("provider.usage", expected, actual, check),
} satisfies EvaluatorDefinition;
