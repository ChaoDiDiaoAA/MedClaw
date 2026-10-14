import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "context.delivery", name: "context.delivery", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新口径）；原工程条件保留", formula: "快照、实际请求、调用身份及依据一致链/应验链；不替代原交付保存工程判据",
  evaluate: (expected, actual, check, context) => behavior("context.delivery", expected, actual, check),
} satisfies EvaluatorDefinition;
