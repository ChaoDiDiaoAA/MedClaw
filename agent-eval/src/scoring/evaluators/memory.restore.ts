import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "memory.restore", name: "memory.restore", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "兼容参考", formula: "[原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)保留：恢复当前位置或预定回合检查点符合预期/全部适用重启与检查点恢复机会；对应memory.history_use；恢复位置/实例机制与后续实际采用分别核验；不与新8.5重复计分",
  evaluate: (expected, actual, check, context) => native("memory.restore", expected, actual, check),
} satisfies EvaluatorDefinition;
