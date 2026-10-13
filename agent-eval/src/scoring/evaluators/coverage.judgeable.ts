import type { EvaluatorDefinition } from '../types.ts';
import { unknown, record } from '../rules.ts';
import { judgeableCoverage } from '../runtime.ts';
export default {
  id: "coverage.judgeable", name: "coverage.judgeable", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；P+F/计划适用检查数",
  evaluate: (expected, actual, check, context) => Array.isArray(actual) && actual.every(x => record(x) && typeof x.checkId === 'string' && ['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN'].includes(x.status) && typeof x.applicable === 'boolean') ? judgeableCoverage(expected, actual, check) : unknown('Coverage derives from controller score states, not Agent claims'),
} satisfies EvaluatorDefinition;
