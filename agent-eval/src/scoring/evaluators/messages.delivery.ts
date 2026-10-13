import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "messages.delivery", name: "messages.delivery", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；原生消息按正确Session/Run进入后续请求的机会/全部应交付机会",
  evaluate: (expected, actual, check, context) => native("messages.delivery", expected, actual, check),
} satisfies EvaluatorDefinition;
