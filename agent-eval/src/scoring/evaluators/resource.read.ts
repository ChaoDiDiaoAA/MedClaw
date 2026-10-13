import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "resource.read", name: "resource.read", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "兼容参考", formula: "[原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)保留：实际读取适用资源/要求读取机会；对应resource.progressive_read / resource.follow；读过不等于按需读取或遵循；不与新8.5重复计分",
  evaluate: (expected, actual, check, context) => native("resource.read", expected, actual, check),
} satisfies EvaluatorDefinition;
