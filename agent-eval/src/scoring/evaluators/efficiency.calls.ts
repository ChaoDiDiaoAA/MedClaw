import type { EvaluatorDefinition } from '../types.ts';
import { measurement } from '../measurements.ts';
import { record } from '../rules.ts';
export default {
  id: "efficiency.calls", name: "efficiency.calls", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "运行统计", formula: "原身份/原公式保留；[01§8](01_MedClaw_Agent评测总方案_v1.md#eval01-8)；每Trial真实意图/主/压缩/子请求和业务/原生/扩展工具调用数",
  evaluate: (expected, actual, check, context) => {
    const result=measurement('efficiency.calls',actual,check);
    return record(expected)&&typeof expected.max==='number'&&result.value!==null?{...result,status:result.value<=expected.max?'PASS':'FAIL',details:{...result.details as object,budget:expected.max}}:result;
  },
} satisfies EvaluatorDefinition;
