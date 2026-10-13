import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "messages.context", name: "messages.context", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；当前分支、压缩边界及允许材料均正确的上下文构建/全部适用构建机会",
  evaluate: (expected, actual, check, context) => native("messages.context", expected, actual, check),
} satisfies EvaluatorDefinition;
