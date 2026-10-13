import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "context.relevance", name: "context.relevance", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "兼容参考", formula: "[原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)保留：必要资料被选且无禁止资料任务/适用任务；对应context.necessary_coverage / context.current_use；选中材料不等于请求覆盖或实际使用；不与新8.5重复计分",
  evaluate: (expected, actual, check, context) => native("context.relevance", expected, actual, check),
} satisfies EvaluatorDefinition;
