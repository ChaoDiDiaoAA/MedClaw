import type { EvaluatorDefinition } from '../types.ts';
import { correctionMeasurement } from '../runtime.ts';
export default {
  id: "efficiency.correction", name: "efficiency.correction", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；用户纠正输入数、活跃人工时长",
  evaluate: (expected, actual, check, context) => correctionMeasurement(actual),
} satisfies EvaluatorDefinition;
