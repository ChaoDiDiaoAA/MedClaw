import { safeError } from "../../contracts/src/error";
import type { DiagnosticsEntry } from "../../contracts/src/protocol";
import { safeLogContext, type LogContext, type LogSource } from "./error-log";

const stages: Record<string, string> = {
  host_start: "Host 正在启动", host_ready: "Host 已就绪", host_stop: "Host 正在停止", host_stopped: "Host 已退出", host_failure: "Host 发生故障",
  request_received: "已接收操作", run_started: "运行已开始", call_started: "模型调用已开始", call_finished: "模型调用已结束",
  run_stopped: "执行已停止", run_saved: "运行事实已保存", config_published: "配置已发布", catalog_refresh: "正在刷新模型目录",
  auth_started: "认证已开始", auth_finished: "认证已结束", preview_dropped: "临时预览已合并或省略",
  "provider.preview": "临时预览已更新", "provider.settled": "运行已保存", "provider.persistence_failed": "运行事实尚未保存",
};
export function safeStageMessage(message: string, context: LogContext = {}) {
  const label = Object.hasOwn(stages, message) ? stages[message]! : "诊断内容已省略";
  const lengths = ["inputChars", "outputChars"] as const;
  return (label + lengths.flatMap(key => Number.isSafeInteger(context[key]) && context[key]! >= 0 ? [` ${key}=${context[key]}`] : []).join("")).slice(0, 2000);
}
export class RuntimeLog {
  private entries: DiagnosticsEntry[] = [];
  private stderr = "";
  constructor(private readonly source: LogSource = "host") {}
  add(message: string, context: LogContext = {}) {
    this.entries.push({ category: "runtime", source: this.source, ...safeLogContext(context), message: safeStageMessage(message, context) });
    if (this.entries.length > 200) this.entries.shift();
  }
  addStderr(raw: string) {
    const code = raw.trim();
    const error = safeError(code);
    const message = error.code === "internal_error" ? `Host 诊断输出已省略（${raw.length} 字符）` : error.message;
    this.stderr = `${this.stderr}${message}\n`.slice(-6000);
    this.add("host_failure");
  }
  stderrTail() { return this.stderr; }
  read() { return structuredClone(this.entries); }
}
