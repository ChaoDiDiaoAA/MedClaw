import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "provider.output_limit", name: "provider.output_limit", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；正确采用可信Pi/用户声明maxTokens或拒绝无效上限的尝试/全部Provider请求及无效上限拒绝机会",
  evaluate: (expected, actual, check, context) => native("provider.output_limit", expected, actual, check),
} satisfies EvaluatorDefinition;
