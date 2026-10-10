-- Schema13 preserves the original model_calls columns, IDs and Pi/P13 constraints.
DROP TRIGGER model_calls_owner_insert;
DROP TRIGGER model_calls_owner_update;
DROP TRIGGER tool_calls_model_owner_insert;
DROP TRIGGER tool_calls_model_owner_update;
DROP TRIGGER tool_context_owner_insert;

CREATE TABLE model_calls_p14 (
  id INTEGER PRIMARY KEY, call_id TEXT NOT NULL UNIQUE,
  run_id INTEGER REFERENCES runs(id), session_id INTEGER REFERENCES sessions(id),
  input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('main','diagnostic','compaction','intent')),
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
  CHECK(kind<>'intent' OR (
    run_id IS NOT NULL AND session_id IS NOT NULL AND input_id IS NOT NULL
    AND attempt=1 AND granularity='logical_request' AND attempt_count_unknown=0
    AND cost IS NULL AND cost_currency IS NULL
    AND (usage_source IS NULL OR usage_source='ollama_reported')
    AND json_extract(model_json,'$.selection.api') IS 'ollama-chat'
    AND json_type(model_json,'$.context.snapshotId') IS 'integer'
    AND json_extract(model_json,'$.context.snapshotId')>0
    AND json_extract(model_json,'$.context.inputId') IS input_id
    AND json_extract(model_json,'$.sdkStopReason') IS NULL
  )),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  CHECK(input_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO model_calls_p14(
  id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,
  model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,
  cost_currency,usage_source,unavailable_reason,error_json
) SELECT id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,
  model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,
  cost_currency,usage_source,unavailable_reason,error_json FROM model_calls;
DROP TABLE model_calls;
ALTER TABLE model_calls_p14 RENAME TO model_calls;
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

CREATE TABLE query_contexts (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
  native_leaf_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  source_input_id INTEGER NOT NULL,
  source_run_id INTEGER NOT NULL,
  context_intent_id TEXT NOT NULL,
  task_intents_json TEXT NOT NULL CHECK(json_valid(task_intents_json)),
  schema_version TEXT NOT NULL,
  adopted_slots_json TEXT NOT NULL CHECK(json_valid(adopted_slots_json)),
  scope_batch_hashes_json TEXT NOT NULL CHECK(json_valid(scope_batch_hashes_json)),
  query_ids_json TEXT NOT NULL CHECK(json_valid(query_ids_json)),
  pending_clarification_json TEXT CHECK(pending_clarification_json IS NULL OR json_valid(pending_clarification_json)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id,native_leaf_id)
    REFERENCES memories(session_id,native_entry_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(source_input_id,session_id)
    REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(source_run_id,session_id)
    REFERENCES runs(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE intent_calls (
  id INTEGER PRIMARY KEY,
  model_call_id INTEGER NOT NULL UNIQUE,
  run_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  input_id INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('classify','verify')),
  previous_call_id INTEGER,
  taxonomy_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  input_projection_json TEXT NOT NULL CHECK(json_valid(input_projection_json)),
  raw_output TEXT,
  parsed_result_json TEXT CHECK(parsed_result_json IS NULL OR json_valid(parsed_result_json)),
  validation_json TEXT CHECK(validation_json IS NULL OR json_valid(validation_json)),
  validation_state TEXT NOT NULL CHECK(validation_state IN ('pending','valid','invalid','not_run')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id,run_id,session_id),
  UNIQUE(run_id,stage),
  CHECK((stage='classify' AND previous_call_id IS NULL) OR
        (stage='verify' AND previous_call_id IS NOT NULL)),
  FOREIGN KEY(previous_call_id,run_id,session_id)
    REFERENCES intent_calls(id,run_id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(model_call_id,run_id,session_id)
    REFERENCES model_calls(id,run_id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(input_id,session_id)
    REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(snapshot_id,run_id,session_id)
    REFERENCES context_snapshots(id,run_id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER intent_verify_previous BEFORE INSERT ON intent_calls
WHEN NEW.stage='verify' AND NOT EXISTS (
  SELECT 1 FROM intent_calls c WHERE c.id=NEW.previous_call_id
    AND c.run_id=NEW.run_id AND c.session_id=NEW.session_id
    AND c.input_id=NEW.input_id AND c.stage='classify'
) BEGIN SELECT RAISE(ABORT,'intent_verify_previous_mismatch'); END;
CREATE INDEX intent_calls_session ON intent_calls(session_id,id DESC);

CREATE TABLE route_decisions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  input_id INTEGER NOT NULL,
  intent_call_id INTEGER,
  route TEXT NOT NULL CHECK(route IN ('simple','agent','clarify','reject')),
  decision_source TEXT NOT NULL CHECK(decision_source IN ('deterministic_rule','validated_model','user_form','explicit_agent_fallback')),
  matched_by TEXT CHECK(matched_by IN ('rule','qwen_prompt','paper_enhanced')),
  business_status TEXT CHECK(business_status IN ('RESOLVED','AMBIGUOUS','OUT_OF_SCOPE','UNSUPPORTED_DATA','NEED_PARAMETERS')),
  rule_evaluation_json TEXT CHECK(rule_evaluation_json IS NULL OR json_valid(rule_evaluation_json)),
  adopted_intents_json TEXT NOT NULL CHECK(json_valid(adopted_intents_json)),
  context_intent_id TEXT,
  adopted_slots_json TEXT CHECK(adopted_slots_json IS NULL OR json_valid(adopted_slots_json)),
  query_params_json TEXT CHECK(query_params_json IS NULL OR json_valid(query_params_json)),
  missing_slots_json TEXT NOT NULL CHECK(json_valid(missing_slots_json)),
  issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
  schema_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(route<>'simple' OR (query_params_json IS NOT NULL AND business_status IS 'RESOLVED')),
  CHECK(route NOT IN ('simple','agent') OR decision_source IN ('user_form','explicit_agent_fallback') OR business_status IS 'RESOLVED'),
  CHECK((decision_source='deterministic_rule' AND intent_call_id IS NULL AND matched_by IS 'rule') OR
        (decision_source='validated_model' AND intent_call_id IS NOT NULL AND matched_by IS NOT NULL AND matched_by IN ('qwen_prompt','paper_enhanced')) OR
        (decision_source IN ('user_form','explicit_agent_fallback') AND intent_call_id IS NULL AND matched_by IS NULL)),
  CHECK(decision_source IN ('user_form','explicit_agent_fallback') OR business_status IS NOT NULL),
  FOREIGN KEY(run_id,session_id)
    REFERENCES runs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(input_id,session_id)
    REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(intent_call_id,run_id,session_id)
    REFERENCES intent_calls(id,run_id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX route_decisions_session ON route_decisions(session_id,id DESC);

CREATE TRIGGER intent_model_owner_insert BEFORE INSERT ON model_calls
WHEN NEW.kind='intent' AND NOT EXISTS (
  SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id
  JOIN session_inputs i ON i.id=r.input_id
  JOIN context_snapshots x ON x.id=json_extract(NEW.model_json,'$.context.snapshotId')
  WHERE r.id=NEW.run_id AND r.kind='agent' AND r.parent_run_id IS NULL
    AND s.id=NEW.session_id AND s.kind='user'
    AND i.id=NEW.input_id AND i.session_id=s.id AND i.target_run_id=r.id
    AND x.run_id=r.id AND x.session_id=s.id AND x.input_id=i.id
    AND json_extract(x.snapshot_json,'$.intentSource.contract') IS 'medclaw.intent-context/v1'
    AND json_extract(x.snapshot_json,'$.intentSource.inputId') IS i.id
) BEGIN SELECT RAISE(ABORT,'intent_model_owner_mismatch'); END;
CREATE TRIGGER intent_model_identity_immutable BEFORE UPDATE ON model_calls
WHEN (OLD.kind='intent' OR NEW.kind='intent') AND (
  NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.call_id IS NOT OLD.call_id
  OR NEW.run_id IS NOT OLD.run_id OR NEW.session_id IS NOT OLD.session_id OR NEW.input_id IS NOT OLD.input_id
  OR json_extract(NEW.model_json,'$.selection') IS NOT json_extract(OLD.model_json,'$.selection')
  OR json_extract(NEW.model_json,'$.context.snapshotId') IS NOT json_extract(OLD.model_json,'$.context.snapshotId')
  OR json_extract(NEW.model_json,'$.context.inputId') IS NOT json_extract(OLD.model_json,'$.context.inputId')
) BEGIN SELECT RAISE(ABORT,'intent_model_identity_immutable'); END;

CREATE TRIGGER intent_call_owner_insert BEFORE INSERT ON intent_calls
WHEN NOT EXISTS (
  SELECT 1 FROM model_calls m JOIN context_snapshots x ON x.id=NEW.snapshot_id
  WHERE m.id=NEW.model_call_id AND m.kind='intent' AND m.run_id=NEW.run_id
    AND m.session_id=NEW.session_id AND m.input_id=NEW.input_id
    AND json_extract(m.model_json,'$.context.snapshotId') IS x.id
    AND x.run_id=NEW.run_id AND x.session_id=NEW.session_id AND x.input_id=NEW.input_id
) BEGIN SELECT RAISE(ABORT,'intent_call_owner_mismatch'); END;
CREATE TRIGGER intent_call_identity_immutable BEFORE UPDATE ON intent_calls
WHEN NEW.id IS NOT OLD.id OR NEW.model_call_id IS NOT OLD.model_call_id
  OR NEW.run_id IS NOT OLD.run_id OR NEW.session_id IS NOT OLD.session_id OR NEW.input_id IS NOT OLD.input_id
  OR NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.stage IS NOT OLD.stage OR NEW.previous_call_id IS NOT OLD.previous_call_id
  OR NEW.taxonomy_version IS NOT OLD.taxonomy_version OR NEW.rule_version IS NOT OLD.rule_version
  OR NEW.prompt_version IS NOT OLD.prompt_version OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.input_projection_json IS NOT OLD.input_projection_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'intent_call_identity_immutable'); END;

CREATE TRIGGER route_decision_owner_insert BEFORE INSERT ON route_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id JOIN session_inputs i ON i.id=r.input_id
  WHERE r.id=NEW.run_id AND r.kind='agent' AND r.parent_run_id IS NULL AND s.kind='user'
    AND s.id=NEW.session_id AND i.id=NEW.input_id AND i.session_id=s.id AND i.target_run_id=r.id
) OR (NEW.intent_call_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intent_calls c WHERE c.id=NEW.intent_call_id AND c.run_id=NEW.run_id
    AND c.session_id=NEW.session_id AND c.input_id=NEW.input_id
)) BEGIN SELECT RAISE(ABORT,'route_decision_owner_mismatch'); END;
CREATE TRIGGER route_decision_immutable BEFORE UPDATE ON route_decisions
BEGIN SELECT RAISE(ABORT,'route_decision_immutable'); END;

CREATE TRIGGER query_context_owner_insert BEFORE INSERT ON query_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id
  WHERE r.id=NEW.source_run_id AND r.kind='agent' AND s.kind='user'
    AND s.id=NEW.session_id AND r.input_id=NEW.source_input_id
) BEGIN SELECT RAISE(ABORT,'query_context_owner_mismatch'); END;
CREATE TRIGGER query_context_owner_update BEFORE UPDATE ON query_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id
  WHERE r.id=NEW.source_run_id AND r.kind='agent' AND s.kind='user'
    AND s.id=NEW.session_id AND r.input_id=NEW.source_input_id
) BEGIN SELECT RAISE(ABORT,'query_context_owner_mismatch'); END;

-- Intent snapshots prove the accepted root input and saved baseline; they do not claim native consumption.
DROP TRIGGER context_snapshot_input_owner;
CREATE TRIGGER context_snapshot_input_owner BEFORE INSERT ON context_snapshots
WHEN NEW.input_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM session_inputs i JOIN runs r ON r.id=NEW.run_id JOIN sessions s ON s.id=NEW.session_id
  WHERE i.id=NEW.input_id AND i.session_id=NEW.session_id AND r.session_id=s.id AND (
    (json_type(NEW.snapshot_json,'$.intentSource') IS NULL
      AND i.run_id=r.id AND i.status='consumed' AND i.native_entry_id IS NOT NULL)
    OR (json_extract(NEW.snapshot_json,'$.intentSource.contract') IS 'medclaw.intent-context/v1'
      AND json_extract(NEW.snapshot_json,'$.intentSource.inputId') IS i.id
      AND json_extract(NEW.snapshot_json,'$.intentSource.baseLeafId') IS s.current_leaf_id
      AND json_extract(NEW.snapshot_json,'$.intentSource.baseStorageVersion') IS s.storage_version
      AND r.kind='agent' AND s.kind='user' AND r.input_id=i.id AND i.target_run_id=r.id
      AND r.status IN ('created','running') AND r.cancel_requested_at IS NULL)
  )
) BEGIN SELECT RAISE(ABORT,'context_input_owner_mismatch'); END;
