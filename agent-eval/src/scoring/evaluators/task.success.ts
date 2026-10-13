import type { EvaluatorDefinition } from '../types.ts';
import { unknown } from '../rules.ts';
export default {
  id: "task.success", name: "task.success", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "结果", formula: "业务事实、产物、回答及必要依据通过的Trial/全部计划适用Trial；过程和安全单列，整体判定保留硬失败",
  evaluate: (expected, actual, check, context) => unknown('Task outcome derives from independent business result checks in evaluate'),
} satisfies EvaluatorDefinition;
