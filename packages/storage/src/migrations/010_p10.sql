DROP TRIGGER model_calls_owner_insert;
DROP TRIGGER model_calls_owner_update;
DROP TRIGGER tool_calls_model_owner_insert;
DROP TRIGGER tool_calls_model_owner_update;
DROP TRIGGER tool_context_owner_insert;

CREATE TABLE model_calls_p10 (
  id INTEGER PRIMARY KEY, call_id TEXT NOT NULL UNIQUE,
  run_id INTEGER REFERENCES runs(id), session_id INTEGER REFERENCES sessions(id),
  input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('main','diagnostic','compaction')),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  granularity TEXT NOT NULL CHECK(granularity IN ('logical_request','http_attempt')),
  attempt_count_unknown INTEGER NOT NULL CHECK(attempt_count_unknown IN (0,1)),
  model_json TEXT NOT NULL CHECK(json_valid(model_json)),
  state TEXT NOT NULL CHECK(state IN ('started','completed','failed','cancelled')),
  started_at TEXT NOT NULL, ended_at TEXT,
  duration_ms REAL CHECK(duration_ms IS NULL OR duration_ms>=0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  cost REAL CHECK(cost IS NULL OR cost>=0), cost_currency TEXT,
  usage_source TEXT, unavailable_reason TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  CHECK(cost IS NULL OR (cost_currency IS NOT NULL AND length(trim(cost_currency))>0)),
  CHECK(run_id IS NOT NULL OR session_id IS NULL OR kind='compaction'),
  CHECK(kind<>'compaction' OR (
    session_id IS NOT NULL AND input_id IS NULL
    AND json_type(model_json,'$.compaction') IS 'object'
    AND json_extract(model_json,'$.compaction.contract') IS 'medclaw.compaction/v1'
    AND json_type(model_json,'$.compaction.operationRef') IS 'text'
    AND length(json_extract(model_json,'$.compaction.operationRef'))>0
    AND json_type(model_json,'$.compaction.ordinal') IS 'integer'
    AND json_extract(model_json,'$.compaction.ordinal')>0
    AND json_type(model_json,'$.compaction.reason') IS 'text'
    AND ((json_extract(model_json,'$.compaction.source') IS 'manual'
          AND json_extract(model_json,'$.compaction.reason') IS 'manual' AND run_id IS NULL)
      OR (json_extract(model_json,'$.compaction.source') IS 'auto'
          AND json_extract(model_json,'$.compaction.reason') IN ('threshold','overflow') AND run_id IS NOT NULL))
  )),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  CHECK(input_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO model_calls_p10(
  id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,
  model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,
  cost_currency,usage_source,unavailable_reason,error_json
) SELECT id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,
  model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,
  cost_currency,usage_source,unavailable_reason,error_json FROM model_calls;
DROP TABLE model_calls;
ALTER TABLE model_calls_p10 RENAME TO model_calls;
CREATE INDEX model_calls_run ON model_calls(run_id,id);
CREATE UNIQUE INDEX model_calls_context_owner ON model_calls(id,run_id,session_id);
CREATE INDEX model_calls_compaction_operation
  ON model_calls(json_extract(model_json,'$.compaction.operationRef'),id)
  WHERE kind='compaction';
CREATE TRIGGER model_calls_owner_insert BEFORE INSERT ON model_calls
WHEN NEW.run_id IS NOT NULL
 AND NEW.session_id IS NOT (SELECT session_id FROM runs WHERE id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'model_call_owner_mismatch'); END;
CREATE TRIGGER model_calls_owner_update BEFORE UPDATE OF run_id,session_id ON model_calls
WHEN NEW.run_id IS NOT NULL
 AND NEW.session_id IS NOT (SELECT session_id FROM runs WHERE id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'model_call_owner_mismatch'); END;
CREATE TRIGGER tool_calls_model_owner_insert BEFORE INSERT ON tool_calls
WHEN NEW.model_call_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM model_calls WHERE id=NEW.model_call_id
 AND run_id=NEW.run_id AND session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'tool_model_owner_mismatch'); END;
CREATE TRIGGER tool_calls_model_owner_update
BEFORE UPDATE OF model_call_id,run_id,session_id ON tool_calls
WHEN NEW.model_call_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM model_calls WHERE id=NEW.model_call_id
 AND run_id=NEW.run_id AND session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'tool_model_owner_mismatch'); END;
CREATE TRIGGER tool_context_owner_insert BEFORE INSERT ON tool_calls
WHEN NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM context_snapshots s JOIN model_calls c ON c.id=NEW.model_call_id
 WHERE s.id=NEW.context_snapshot_id AND s.run_id=NEW.run_id AND s.session_id=NEW.session_id
 AND c.run_id=NEW.run_id AND c.session_id=NEW.session_id
 AND json_extract(c.model_json,'$.context.snapshotId')=s.id)
BEGIN SELECT RAISE(ABORT,'tool_context_owner_mismatch'); END;
