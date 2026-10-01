import { z } from "zod";

export const PositiveIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const OpaqueIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const TimestampSchema = z.string().datetime({ offset: true }).max(64);
export const ErrorCategorySchema = z.enum(["provider", "runtime", "tool", "session", "storage", "input", "extension", "internal"]);
export const ErrorReasonSchema = z.enum(["runtime_busy", "workspace_revision_mismatch", "session_not_found", "message_cursor_invalid", "input_cursor_invalid", "host_interrupted"]);

export const AppErrorSchema = z.strictObject({
  code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/),
  category: ErrorCategorySchema,
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  reason: ErrorReasonSchema.optional(),
  operationRef: OpaqueIdSchema.optional(),
  runId: PositiveIdSchema.optional(),
  sessionId: PositiveIdSchema.optional(),
  toolCallId: PositiveIdSchema.optional(),
});
export type AppError = z.infer<typeof AppErrorSchema>;
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };
export const resultSchema = <S extends z.ZodType>(data: S) => z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data }),
  z.strictObject({ ok: z.literal(false), error: AppErrorSchema }),
]);

const errorDefinitions = {
  access_denied: ["input", "无权执行此操作。", false],
  invalid_argument: ["input", "输入参数无效，请检查后重试。", false],
  input_invalid: ["input", "输入对象无效，请检查后重试。", false],
  session_history_invalid: ["session", "此会话的进程内历史不可用，请创建新会话。", false],
  runtime_interrupted: ["runtime", "运行因 Host 中断而结束，原请求不会自动重发。", false],
  state_conflict: ["runtime", "原操作身份与此次参数不一致。", false],
  workspace_revision_mismatch: ["session", "当前查看对象已变化，请重新读取后选择。", true],
  session_not_found: ["session", "找不到此会话。", false],
  session_history_unavailable: ["session", "此会话的进程内历史已不可用，请创建新会话。", false],
  native_state_invalid: ["session", "此会话的原生状态未确认，请创建新会话。", false],
  stop_unconfirmed: ["runtime", "实际执行停止尚未确认，暂时不能开始新运行。", true],
  agent_response_unsupported: ["runtime", "模型返回了本阶段不支持的工具或延迟响应。", false],
  runtime_busy: ["runtime", "已有操作仍在执行，请等待或停止后重试。", true],
  config_conflict: ["input", "配置版本已变化，请重新读取后提交。", true],
  config_read_failed: ["storage", "无法读取已发布配置。", true],
  config_write_failed: ["storage", "配置未确认保存，请先读取当前配置。", true],
  model_not_found: ["provider", "所选模型当前不可用，请重新选择。", false],
  model_auth_missing: ["provider", "所选供应商尚未提供可用认证。", false],
  model_output_limit_missing: ["provider", "模型缺少已确认的输出上限。", false],
  model_auth_sync_failed: ["provider", "凭据可能已保存，但认证同步未确认，请查询当前状态。", true],
  model_catalog_too_large: ["provider", "模型目录超过传输上限。", false],
  custom_provider_invalid: ["input", "自定义供应商定义无效。", false],
  provider_id_reserved: ["input", "自定义供应商不能覆盖内置供应商。", false],
  custom_api_unsupported: ["provider", "此模型 API 没有可用的原生实现。", false],
  retry_policy_unsupported: ["provider", "此模型 API 无法兑现所选重试策略。", false],
  provider_request_failed: ["provider", "模型请求失败，请查看已保存的运行状态。", true],
  provider_refresh_failed: ["provider", "模型目录刷新失败，仍可查看上一份目录。", true],
  preview_delivery_failed: ["runtime", "临时预览未送达，请按原运行查询最终结果。", true],
  auth_method_unsupported: ["provider", "此供应商不支持所选登录方式。", false],
  run_save_unavailable: ["storage", "原运行的冻结事实已不可用，无法补造保存。", false],
  auth_failed: ["provider", "认证未确认成功，请查询当前认证状态。", true],
  provider_response_unsupported: ["provider", "模型返回了本阶段不支持的响应。", false],
  run_timeout: ["runtime", "模型请求超过运行时限。", true],
  run_not_found: ["input", "找不到此运行。", false],
  operation_not_found: ["input", "找不到此操作。", false],
  auth_attempt_not_found: ["input", "此认证尝试已失效，请查询当前认证状态。", false],
  auth_prompt_invalid: ["input", "此认证提示已失效或答复无效。", false],
  operation_result_unknown: ["runtime", "原操作结果尚未确认，请按原身份查询。", true],
  storage_write_failed: ["storage", "运行事实尚未确认保存，请重试保存原运行。", true],
  storage_read_failed: ["storage", "无法读取已保存的运行事实。", true],
  storage_migration_failed: ["storage", "数据库校验或迁移失败，Host 无法就绪。", false],
  credential_storage_unavailable: ["storage", "系统安全凭据存储不可用。", false],
  credential_write_failed: ["storage", "凭据未确认安全保存，请查询当前认证状态。", true],
  credential_read_failed: ["storage", "无法读取安全凭据。", true],
  credential_lease_invalid: ["runtime", "凭据操作身份或基准版本不匹配。", false],
  host_protocol_mismatch: ["runtime", "Host 协议或依赖版本不匹配。", false],
  host_start_failed: ["runtime", "Host 启动失败。", true],
  host_not_ready: ["runtime", "Host 尚未就绪。", true],
  host_stop_unconfirmed: ["runtime", "Host 退出尚未确认，暂时不能启动另一进程。", true],
  host_interrupted: ["runtime", "Host 已中断，原运行不会自动重发。", false],
  frame_too_large: ["runtime", "协议消息超过传输上限。", false],
  invalid_frame: ["runtime", "协议消息无效。", false],
  internal_error: ["internal", "操作失败，请查看安全诊断。", false],
} as const satisfies Record<string, readonly [AppError["category"], string, boolean]>;
export type AppErrorCode = keyof typeof errorDefinitions;
export type ErrorContext = Pick<AppError, "operationRef" | "runId" | "sessionId" | "toolCallId" | "reason">;

/** Native errors are deliberately not copied: message/body/cause can contain credentials. */
export function safeError(code: string, _native?: unknown, context: ErrorContext = {}): AppError {
  const safeCode = Object.hasOwn(errorDefinitions, code) ? code as AppErrorCode : "internal_error";
  const [category, message, retryable] = errorDefinitions[safeCode];
  const error: AppError = { code: safeCode, category, message, retryable };
  for (const key of ["operationRef", "runId", "sessionId", "toolCallId", "reason"] as const) {
    const value = context[key];
    if (value !== undefined && AppErrorSchema.shape[key].safeParse(value).success) Object.assign(error, { [key]: value });
  }
  if (safeCode === "runtime_busy" || safeCode === "host_interrupted" || safeCode === "workspace_revision_mismatch" || safeCode === "session_not_found") error.reason = safeCode;
  if (safeCode === "state_conflict" && error.reason === "runtime_busy") error.message = errorDefinitions.runtime_busy[1];
  if (safeCode === "state_conflict" && error.reason === "workspace_revision_mismatch") error.message = errorDefinitions.workspace_revision_mismatch[1];
  if (safeCode === "input_invalid" && error.reason === "session_not_found") error.message = errorDefinitions.session_not_found[1];
  if (safeCode === "runtime_interrupted") error.reason = "host_interrupted";
  return error;
}

/** Convert trusted service exceptions to fixed product text; never copy native bodies. */
export async function serviceResult<T>(action: () => T | Promise<T>, fallback: AppErrorCode, context: ErrorContext = {}): Promise<Result<T>> {
  try { return { ok: true, data: await action() }; }
  catch (native) {
    const known = AppErrorSchema.safeParse(native);
    let code = known.success ? known.data.code : native instanceof z.ZodError ? "invalid_argument" : native instanceof Error ? native.message : fallback;
    const errorContext = { ...context, ...(known.success ? { reason: known.data.reason } : {}) };
    if (code === "workspace_revision_mismatch") { code = "state_conflict"; errorContext.reason = "workspace_revision_mismatch"; }
    if (code === "session_not_found") { code = "input_invalid"; errorContext.reason = "session_not_found"; }
    if (code === "session_history_unavailable" || code === "native_state_invalid") code = "session_history_invalid";
    return { ok: false, error: safeError(Object.hasOwn(errorDefinitions, code) ? code : fallback, undefined, errorContext) };
  }
}
