import type { EvaluatorDefinition } from '../types.ts';
import { native } from '../native.ts';
export default {
  id: "host.shutdown", name: "host.shutdown", version: 'v1', kind: 'deterministic', behavior: false,
  layer: "工程验收条件", formula: "工程条件保留；[01附录A原定义/证据](01_MedClaw_Agent评测总方案_v1.md#eval01-legacy-harness)；停止受理、真实执行停止、必要收尾及进程退出成立/全部退出机会",
  evaluate: (expected, actual, check, context) => native("host.shutdown", expected, actual, check),
} satisfies EvaluatorDefinition;
