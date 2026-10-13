import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "subagent.scope", name: "subagent.scope", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；符合父业务范围的子业务调用/全部适用子业务调用；只读工具装配另检查",
  evaluate: (expected, actual, check, context) => native("subagent.scope", expected, actual, check),
} satisfies EvaluatorDefinition;
