import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "tool.result", name: "tool.result", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；输出/业务检查及阶段状态均如实机会/全部适用机会",
  evaluate: (expected, actual, check, context) => native("tool.result", expected, actual, check),
} satisfies EvaluatorDefinition;
