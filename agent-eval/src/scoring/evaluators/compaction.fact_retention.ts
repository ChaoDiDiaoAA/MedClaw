import type { EvaluatorDefinition } from '../types.ts';
import { behavior } from '../behavior.ts';
export default {
  id: "compaction.fact_retention", name: "compaction.fact_retention", version: 'v1', kind: 'deterministic', behavior: true,
  layer: "正式质量（新增行为）", formula: "harness-behavior/v1：已实现判据，采证可用性见本批工程记录；[01§8.5](01_MedClaw_Agent评测总方案_v1.md#eval01-8-5)；压缩关键事实保留率：后续正确使用必要事实与来源点/应保留点 ↑",
  evaluate: (expected, actual, check, context) => behavior("compaction.fact_retention", expected, actual, check),
} satisfies EvaluatorDefinition;
