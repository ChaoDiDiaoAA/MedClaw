import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "memory.branch", name: "memory.branch", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "兼容参考", formula: "[原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)保留：条件来自目标可达分支或正确清空/全部预定分支恢复与切换机会；对应memory.history_use / context.correction；分支条件检查不直接等同历史使用；不与新8.5重复计分",
  evaluate: (expected, actual, check, context) => native("memory.branch", expected, actual, check),
} satisfies EvaluatorDefinition;
