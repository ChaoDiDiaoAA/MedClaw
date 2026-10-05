import { z } from "zod";

export const PositiveIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const OpaqueIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const TimestampSchema = z.string().datetime({ offset: true }).max(64);
export const ErrorCategorySchema = z.enum(["provider", "runtime", "tool", "session", "storage", "input", "extension", "internal"]);
export const ErrorReasonSchema = z.enum(["runtime_busy", "workspace_revision_mismatch", "session_not_found", "session_deleted", "session_metadata_revision_mismatch", "message_cursor_invalid", "input_cursor_invalid", "host_interrupted"]);

export const EventRangeErrorSchema = z.strictObject({ runId: PositiveIdSchema, firstSequence: PositiveIdSchema.nullable(), lastSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), resumeAfterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).refine(value => (value.firstSequence === null ? value.lastSequence === 0 : value.firstSequence <= value.lastSequence) && (value.resumeAfterSequence === null || value.resumeAfterSequence <= value.lastSequence));
export type EventRangeError = z.infer<typeof EventRangeErrorSchema>;

export const AppErrorSchema = z.strictObject({
  code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/),
  category: ErrorCategorySchema,
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  reason: ErrorReasonSchema.optional(),
  eventRange: EventRangeErrorSchema.optional(),
  operationRef: OpaqueIdSchema.optional(),
  runId: PositiveIdSchema.optional(),
  sessionId: PositiveIdSchema.optional(),
  toolCallId: PositiveIdSchema.optional(),
}).refine(error => !error.eventRange || error.code === "event_cursor_invalid" || error.code === "event_gap", "Range metadata requires an event range error");
// Range metadata is reserved for cursor and gap failures.
export type AppError = z.infer<typeof AppErrorSchema>;
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };
export const resultSchema = <S extends z.ZodType>(data: S) => z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data }),
  z.strictObject({ ok: z.literal(false), error: AppErrorSchema }),
]);

const errorDefinitions = {
  context_delivery_unsupported: ['provider', 'Context delivery cannot be verified for this model API.', false],
  context_payload_mismatch: ['runtime', 'The final model payload does not contain the saved context.', false],
  context_projection_too_large: ['input', 'The required context exceeds the delivery limit. Select fewer materials.', false],
  event_cursor_invalid: ["input", "The event cursor is outside the saved range.", false],
  event_gap: ["storage", "The saved event range has a gap. Read the original facts before resuming.", false],
  event_subscription_invalid: ["input", "The event subscription identity or parameters are invalid.", false],
  event_subscription_limit: ["runtime", "The event subscription limit has been reached.", false],
  tool_not_found: ["tool", "Tool not found.", false],
  tool_input_invalid: ["tool", "The tool input is invalid.", false],
  tool_output_invalid: ["tool", "The tool output does not meet the contract and cannot be used as a valid result.", false],
  tool_result_too_large: ["tool", "The final tool text exceeds the per-call delivery limit. Read the original saved facts with a smaller page or narrower output.", false],
  tool_call_limit: ["tool", "The run reached its configured tool call budget. Review the saved results and unresolved items.", false],
  tool_timeout: ["tool", "The tool exceeded its execution time. Confirm the original operation stopped before retrying.", true],
  tool_output_inconsistent: ["tool", "The tool result conflicts with its business contract. Read the original saved facts before using it.", false],
  tool_recovery_limit: ["tool", "The run reached its configured recovery budget. Unresolved failures remain recorded.", false],
  tool_postprocess_failed: ["tool", "Tool postprocessing failed. Committed facts remain available under their original identity.", true],
  tool_cancelled: ["tool", "The tool call was cancelled. Committed query facts remain available under their original identity.", false],
  data_coverage_missing: ["tool", "Required dates or predecessor batches are missing from the allowed scope. This does not mean there are zero results.", false],
  query_result_too_large: ["tool", "The query result exceeds the storage limit. Narrow the query scope.", false],
  access_denied: ["input", "You do not have permission to perform this operation.", false],
  invalid_argument: ["input", "The input parameters are invalid. Check them and try again.", false],
  input_not_found: ["input", "Input not found.", false],
  input_delivery_unknown: ["runtime", "Input delivery is unconfirmed. Read the original input before taking further action.", false],
  input_cancel_unconfirmed: ["runtime", "Input cancellation is unconfirmed. Read the original input or stop its run.", false],
  input_hook_handled: ["input", "The input was handled before native consumption.", false],
  input_invalid: ["input", "The input object is invalid. Check it and try again.", false],
  session_history_invalid: ["session", "This session's in-process history is unavailable. Create a new session.", false],
  resource_unavailable: ["session", "The required session history or message structure is unavailable. Read the original saved facts.", false],
  runtime_interrupted: ["runtime", "The run ended because the Host was interrupted. The original request will not be resent automatically.", false],
  state_conflict: ["runtime", "The original operation identity does not match these parameters.", false],
  workspace_revision_mismatch: ["session", "The current view has changed. Read it again before selecting.", true],
  session_not_found: ["session", "Session not found.", false],
  session_history_unavailable: ["session", "This session's in-process history is no longer available. Create a new session.", false],
  native_state_invalid: ["session", "This session's native state is unconfirmed. Create a new session.", false],
  stop_unconfirmed: ["runtime", "Execution has not been confirmed stopped. A new run cannot start yet.", true],
  agent_response_unsupported: ["runtime", "The model returned a tool or deferred response that is unsupported at this stage.", false],
  agent_call_limit: ["runtime", "The run reached its model request limit. Review the saved results before starting a new run.", false],
  import_invalid: ["input", "The package did not pass import validation. Review the reported issues.", false],
  import_conflict: ["input", "The package conflicts with an existing batch or data scope.", false],
  import_preview_stale: ["input", "The package or data catalog changed after preview. Preview it again with a new operation.", false],
  import_cancelled: ["input", "The import was cancelled before its business transaction committed.", false],
  file_token_invalid: ["input", "The directory authorization expired or no longer matches this operation. Select the directory again.", true],
  artifact_not_ready: ["storage", "The managed artifact is not ready or its files could not be verified.", true],
  runtime_busy: ["runtime", "An operation is still running. Wait or stop it before trying again.", true],
  config_conflict: ["input", "The configuration version has changed. Read it again before submitting.", true],
  config_read_failed: ["storage", "Unable to read the published configuration.", true],
  config_write_failed: ["storage", "The configuration has not been confirmed saved. Read the current configuration first.", true],
  model_not_found: ["provider", "The selected model is unavailable. Select another model.", false],
  model_auth_missing: ["provider", "The selected provider has no usable authentication.", false],
  model_output_limit_missing: ["provider", "The model has no confirmed output limit.", false],
  model_auth_sync_failed: ["provider", "Credentials may be saved, but authentication synchronization is unconfirmed. Read the current status.", true],
  model_catalog_too_large: ["provider", "The model directory exceeds the transport limit.", false],
  custom_provider_invalid: ["input", "The custom provider definition is invalid.", false],
  provider_id_reserved: ["input", "A custom provider cannot replace a built-in provider.", false],
  custom_api_unsupported: ["provider", "This model API has no available native implementation.", false],
  retry_policy_unsupported: ["provider", "This model API cannot enforce the selected retry policy.", false],
  provider_request_failed: ["provider", "The model request failed. Review the saved run status.", true],
  provider_refresh_failed: ["provider", "The model directory refresh failed. The previous directory is still available.", true],
  preview_delivery_failed: ["runtime", "The temporary preview was not delivered. Read the original run for its final result.", true],
  auth_method_unsupported: ["provider", "This provider does not support the selected sign-in method.", false],
  run_save_unavailable: ["storage", "The original run's frozen facts are unavailable. They cannot be reconstructed for saving.", false],
  auth_failed: ["provider", "Authentication success is unconfirmed. Read the current authentication status.", true],
  provider_response_unsupported: ["provider", "The model returned a response that is unsupported at this stage.", false],
  run_timeout: ["runtime", "The model request exceeded the runtime limit.", true],
  run_not_found: ["input", "Run not found.", false],
  operation_not_found: ["input", "Operation not found.", false],
  auth_attempt_not_found: ["input", "This authentication attempt is no longer valid. Read the current authentication status.", false],
  auth_prompt_invalid: ["input", "This authentication prompt is no longer valid or the response is invalid.", false],
  operation_result_unknown: ["runtime", "The original operation result is unconfirmed. Read it using its original identity.", true],
  storage_write_failed: ["storage", "Run facts have not been confirmed saved. Retry saving the original run.", true],
  storage_read_failed: ["storage", "Unable to read saved run facts.", true],
  storage_migration_failed: ["storage", "Database validation or migration failed. The Host cannot become ready.", false],
  credential_storage_unavailable: ["storage", "System secure credential storage is unavailable.", false],
  credential_write_failed: ["storage", "Credentials have not been confirmed securely saved. Read the current authentication status.", true],
  credential_read_failed: ["storage", "Unable to read secure credentials.", true],
  credential_lease_invalid: ["runtime", "The credential operation identity or base version does not match.", false],
  host_protocol_mismatch: ["runtime", "The Host protocol or dependency version does not match.", false],
  host_start_failed: ["runtime", "The Host failed to start.", true],
  host_not_ready: ["runtime", "The Host is not ready.", true],
  host_stop_unconfirmed: ["runtime", "The Host's exit is unconfirmed. Another process cannot start yet.", true],
  host_interrupted: ["runtime", "The Host was interrupted. The original run will not be resent automatically.", false],
  frame_too_large: ["runtime", "The protocol message exceeds the transport limit.", false],
  invalid_frame: ["runtime", "The protocol message is invalid.", false],
  internal_error: ["internal", "Operation failed. Check diagnostics.", false],
} as const satisfies Record<string, readonly [AppError["category"], string, boolean]>;
export type AppErrorCode = keyof typeof errorDefinitions;
export type ErrorContext = Pick<AppError, "operationRef" | "runId" | "sessionId" | "toolCallId" | "reason" | "eventRange">;

/** Native errors are deliberately not copied: message/body/cause can contain credentials. */
export function safeError(code: string, _native?: unknown, context: ErrorContext = {}): AppError {
  const safeCode = Object.hasOwn(errorDefinitions, code) ? code as AppErrorCode : "internal_error";
  const [category, message, retryable] = errorDefinitions[safeCode];
  const error: AppError = { code: safeCode, category, message, retryable };
  for (const key of ["operationRef", "runId", "sessionId", "toolCallId", "reason"] as const) {
    const value = context[key];
    if (value !== undefined && AppErrorSchema.shape[key].safeParse(value).success) Object.assign(error, { [key]: value });
  }
  if ((safeCode === "event_cursor_invalid" || safeCode === "event_gap") && context.eventRange) { const range = EventRangeErrorSchema.safeParse(context.eventRange); if (range.success) error.eventRange = range.data; }
  if (safeCode === "runtime_busy" || safeCode === "host_interrupted" || safeCode === "workspace_revision_mismatch" || safeCode === "session_not_found") error.reason = safeCode;
  if (safeCode === "state_conflict" && error.reason === "runtime_busy") error.message = errorDefinitions.runtime_busy[1];
  if (safeCode === "state_conflict" && error.reason === "workspace_revision_mismatch") error.message = errorDefinitions.workspace_revision_mismatch[1];
  if (safeCode === "state_conflict" && error.reason === "session_deleted") error.message = 'This session has been deleted. Its original records remain available for reading.';
  if (safeCode === "state_conflict" && error.reason === "session_metadata_revision_mismatch") error.message = 'The session details have changed. Read the current session before trying again.';
  if (safeCode === "input_invalid" && error.reason === "session_not_found") error.message = errorDefinitions.session_not_found[1];
  if (safeCode === "runtime_interrupted") error.reason = "host_interrupted";
  return error;
}

export function errorMessage(error: AppError): string {
  return safeError(error.code, undefined, { reason: error.reason }).message;
}

/** Convert trusted service exceptions to fixed product text; never copy native bodies. */
export async function serviceResult<T>(action: () => T | Promise<T>, fallback: AppErrorCode, context: ErrorContext = {}): Promise<Result<T>> {
  try { return { ok: true, data: await action() }; }
  catch (native) {
    const known = AppErrorSchema.safeParse(native);
    let code = known.success ? known.data.code : native instanceof z.ZodError ? "invalid_argument" : native instanceof Error ? native.message : fallback;
    const errorContext = { ...context, ...(known.success ? { reason: known.data.reason, eventRange: known.data.eventRange,
      operationRef: known.data.operationRef ?? context.operationRef, runId: known.data.runId ?? context.runId,
      sessionId: known.data.sessionId ?? context.sessionId, toolCallId: known.data.toolCallId ?? context.toolCallId } : {}) };
    if (code === "workspace_revision_mismatch") { code = "state_conflict"; errorContext.reason = "workspace_revision_mismatch"; }
    if (code === "session_not_found") { code = "input_invalid"; errorContext.reason = "session_not_found"; }
    if (code === "session_history_unavailable" || code === "native_state_invalid") code = "session_history_invalid";
    return { ok: false, error: safeError(Object.hasOwn(errorDefinitions, code) ? code : fallback, undefined, errorContext) };
  }
}
