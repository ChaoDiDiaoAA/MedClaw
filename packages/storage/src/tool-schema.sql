-- Isolated tool-subsystem schema. Host/P2 migration registration is intentionally separate.
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  run_id INTEGER NOT NULL,
  native_tool_call_id TEXT NOT NULL CHECK(length(native_tool_call_id)>0),
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('PURE','READ','LOCAL_WRITE')),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('sequential','parallel')),
  args_json TEXT NOT NULL CHECK(json_valid(args_json)),
  status TEXT NOT NULL CHECK(status IN ('requested','running','succeeded','failed','cancelled')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  delivery_json TEXT CHECK(delivery_json IS NULL OR json_valid(delivery_json)),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(session_id,native_tool_call_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  CHECK((status IN ('requested','running') AND result_json IS NULL AND error_json IS NULL AND ended_at IS NULL)
    OR (status='succeeded' AND result_json IS NOT NULL AND error_json IS NULL AND ended_at IS NOT NULL)
    OR (status IN ('failed','cancelled') AND error_json IS NOT NULL AND ended_at IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id,id);

CREATE TABLE IF NOT EXISTS queries (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  run_id INTEGER NOT NULL,
  call_ref TEXT NOT NULL UNIQUE CHECK(length(call_ref)>0),
  kind TEXT NOT NULL CHECK(kind IN ('current','changes')),
  source TEXT NOT NULL DEFAULT 'agent_tool' CHECK(source='agent_tool'),
  params_json TEXT NOT NULL CHECK(json_valid(params_json)),
  batch_ids_json TEXT NOT NULL CHECK(json_valid(batch_ids_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id)
) STRICT;
CREATE INDEX IF NOT EXISTS queries_session_created ON queries(session_id,id);

CREATE TABLE IF NOT EXISTS query_evidence (
  id INTEGER PRIMARY KEY,
  query_id INTEGER NOT NULL REFERENCES queries(id),
  batch_ids_json TEXT NOT NULL CHECK(json_valid(batch_ids_json)),
  snapshot_ids_json TEXT NOT NULL CHECK(json_valid(snapshot_ids_json)),
  event_ids_json TEXT NOT NULL CHECK(json_valid(event_ids_json)),
  source_row_refs_json TEXT NOT NULL CHECK(json_valid(source_row_refs_json)),
  calculation_version TEXT NOT NULL,
  material_version TEXT NOT NULL,
  source_bundle_id TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS query_evidence_query ON query_evidence(query_id,id);

CREATE TRIGGER IF NOT EXISTS tool_calls_identity_immutable BEFORE UPDATE ON tool_calls
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.native_tool_call_id IS NOT OLD.native_tool_call_id OR NEW.tool_name IS NOT OLD.tool_name
  OR NEW.tool_version IS NOT OLD.tool_version OR NEW.effect IS NOT OLD.effect
  OR NEW.execution_mode IS NOT OLD.execution_mode OR NEW.args_json IS NOT OLD.args_json
BEGIN SELECT RAISE(ABORT,'tool_identity_immutable'); END;
CREATE TRIGGER IF NOT EXISTS tool_calls_terminal_immutable BEFORE UPDATE ON tool_calls
WHEN OLD.status IN ('succeeded','failed','cancelled') AND (NEW.status IS NOT OLD.status
  OR NEW.result_json IS NOT OLD.result_json OR NEW.error_json IS NOT OLD.error_json
  OR NEW.started_at IS NOT OLD.started_at OR NEW.ended_at IS NOT OLD.ended_at)
BEGIN SELECT RAISE(ABORT,'tool_terminal_immutable'); END;
CREATE TRIGGER IF NOT EXISTS queries_update_immutable BEFORE UPDATE ON queries
BEGIN SELECT RAISE(ABORT,'query_immutable'); END;
CREATE TRIGGER IF NOT EXISTS queries_delete_immutable BEFORE DELETE ON queries
BEGIN SELECT RAISE(ABORT,'query_immutable'); END;
CREATE TRIGGER IF NOT EXISTS query_evidence_update_immutable BEFORE UPDATE ON query_evidence
BEGIN SELECT RAISE(ABORT,'query_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS query_evidence_delete_immutable BEFORE DELETE ON query_evidence
BEGIN SELECT RAISE(ABORT,'query_evidence_immutable'); END;
