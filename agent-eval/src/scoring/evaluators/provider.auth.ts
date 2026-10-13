import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "provider.auth", name: "provider.auth", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；按所选Pi供应商可用方式完成、正确拒绝或如实报告失败的检查/全部P1认证检查与尝试",
  evaluate: (expected, actual, check, context) => native("provider.auth", expected, actual, check),
} satisfies EvaluatorDefinition;
