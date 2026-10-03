-- Schema4 preserves all legacy column values. foreign_keys is managed by openDatabase.
CREATE TABLE session_inputs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  client_sequence INTEGER NOT NULL CHECK(client_sequence>0),
  operation_ref TEXT NOT NULL UNIQUE CHECK(length(operation_ref)>0),
  mode TEXT NOT NULL CHECK(mode IN ('send','steer','follow_up')),
  status TEXT NOT NULL CHECK(status IN ('queued','consumed','failed','cancelled','delivery_unknown')),
  content_json TEXT NOT NULL CHECK(json_valid(content_json))
    CHECK(json_type(content_json) IS 'object'),
  target_run_id INTEGER,
  run_id INTEGER,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(processing_status IN ('pending','completed','failed','cancelled')),
  native_entry_id TEXT CHECK(native_entry_id IS NULL OR length(native_entry_id)>0),
  UNIQUE(session_id,client_sequence),
  UNIQUE(id,session_id),
  UNIQUE(session_id,native_entry_id),
  FOREIGN KEY(target_run_id,session_id) REFERENCES runs(id,session_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(
    (status='queued' AND processing_status='pending') OR
    (status='consumed' AND processing_status IN ('pending','completed','failed','cancelled')) OR
    (status='failed' AND processing_status='failed') OR
    (status='cancelled' AND processing_status='cancelled') OR
    (status='delivery_unknown' AND processing_status IN ('pending','failed','cancelled'))
  ),
  CHECK(status<>'consumed' OR (run_id IS NOT NULL AND native_entry_id IS NOT NULL)),
  CHECK(native_entry_id IS NULL OR run_id IS NOT NULL),
  CHECK((processing_status='pending' AND processed_at IS NULL)
    OR (processing_status<>'pending' AND processed_at IS NOT NULL))
) STRICT;
CREATE INDEX session_inputs_queue ON session_inputs(session_id,status,id);
CREATE INDEX session_inputs_target_run ON session_inputs(target_run_id,id);
CREATE INDEX session_inputs_run ON session_inputs(run_id,id);
CREATE TRIGGER session_inputs_queue_target BEFORE INSERT ON session_inputs WHEN NEW.mode<>'send' AND NEW.target_run_id IS NULL BEGIN SELECT RAISE(ABORT,'input_target_required'); END;
CREATE TABLE runs_p5 (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id), input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('provider','agent')),
  prior_run_id INTEGER REFERENCES runs(id), instance_id TEXT NOT NULL,
  submission_operation_ref TEXT UNIQUE,
  submission_client_sequence INTEGER,
  submission_request_json TEXT
    CHECK(submission_request_json IS NULL OR json_valid(submission_request_json)),
  status TEXT NOT NULL CHECK(status IN ('created','running','completed','failed','cancelled')),
  goal TEXT NOT NULL CHECK(goal IN ('answer','query','verify')),
  input_text TEXT NOT NULL, output_text TEXT,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  workspace_json TEXT CHECK(workspace_json IS NULL OR json_valid(workspace_json)),
  reference_date TEXT NOT NULL, timezone TEXT NOT NULL,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL, started_at TEXT, cancel_requested_at TEXT,
  stopped_at TEXT, ended_at TEXT,
  cleanup_json TEXT CHECK(cleanup_json IS NULL OR json_valid(cleanup_json)),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  UNIQUE(id,session_id), UNIQUE(session_id,submission_client_sequence),
  CHECK(prior_run_id IS NULL OR prior_run_id<>id),
  CHECK(
    (kind='provider' AND input_id IS NULL AND session_id IS NULL AND submission_operation_ref IS NULL
      AND submission_client_sequence IS NULL AND submission_request_json IS NULL)
    OR
    (kind='agent' AND input_id IS NULL AND session_id IS NOT NULL
      AND submission_operation_ref IS NOT NULL AND length(submission_operation_ref)>0
      AND submission_client_sequence IS NOT NULL AND submission_client_sequence>0
      AND submission_request_json IS NOT NULL
      AND json_type(submission_request_json) IS 'object'
      AND json_type(submission_request_json,'$.sessionId') IS 'integer'
      AND json_extract(submission_request_json,'$.sessionId')=session_id
      AND json_type(submission_request_json,'$.clientSequence') IS 'integer'
      AND json_extract(submission_request_json,'$.clientSequence')=submission_client_sequence
      AND workspace_json IS NOT NULL)
    OR (kind='agent' AND input_id IS NOT NULL AND session_id IS NOT NULL AND workspace_json IS NOT NULL
      AND submission_operation_ref IS NULL AND submission_client_sequence IS NULL AND submission_request_json IS NULL)
  ),
  CHECK(kind<>'provider' OR
    (json_type(config_json,'$.providerRequest') IS 'object'
     AND json_type(config_json,'$.providerRequest.operationRef') IS 'text'
     AND length(json_extract(config_json,'$.providerRequest.operationRef'))>0)),
  CHECK(kind<>'agent' OR
    (json_type(config_json,'$.agent') IS 'object'
     AND json_type(config_json,'$.agent.nativeSessionId') IS 'text')),
  CHECK(input_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO runs_p5(id,session_id,input_id,kind,prior_run_id,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,output_text,config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json) SELECT id,session_id,input_id,kind,prior_run_id,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,output_text,config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json FROM runs;
CREATE TABLE model_calls_p5 (
  id INTEGER PRIMARY KEY, call_id TEXT NOT NULL UNIQUE,
  run_id INTEGER REFERENCES runs(id), session_id INTEGER REFERENCES sessions(id),
  input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('main','diagnostic')),
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
  CHECK(run_id IS NOT NULL OR session_id IS NULL),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  CHECK(input_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO model_calls_p5(id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,cost_currency,usage_source,unavailable_reason,error_json) SELECT id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,cost_currency,usage_source,unavailable_reason,error_json FROM model_calls;
CREATE TABLE queries_p5 (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  run_id INTEGER NOT NULL,
  input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  call_ref TEXT NOT NULL UNIQUE CHECK(length(call_ref)>0),
  kind TEXT NOT NULL CHECK(kind IN ('current','changes','aggregate','trend')),
  source TEXT NOT NULL DEFAULT 'agent_tool' CHECK(source IN ('agent_tool','user_form','intent')),
  based_on_query_id INTEGER REFERENCES queries(id),
  params_hash TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK(json_valid(params_json)),
  batch_ids_json TEXT NOT NULL CHECK(json_valid(batch_ids_json)),
  material_version TEXT NOT NULL DEFAULT '',
  catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK(catalog_revision>=0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(id,session_id),
  UNIQUE(id,run_id),
  CHECK(based_on_query_id IS NULL OR based_on_query_id<>id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  CHECK(input_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO queries_p5(id,session_id,run_id,input_id,call_ref,kind,source,based_on_query_id,params_hash,params_json,batch_ids_json,material_version,catalog_revision,result_json,result_hash,created_at) SELECT id,session_id,run_id,input_id,call_ref,kind,source,based_on_query_id,params_hash,params_json,batch_ids_json,material_version,catalog_revision,result_json,result_hash,created_at FROM queries;
CREATE TABLE answers_p5 (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('result','clarification','out_of_scope','insufficient_evidence')),
  text TEXT NOT NULL,
  query_ids_json TEXT NOT NULL CHECK(json_valid(query_ids_json)),
  missing_slots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(missing_slots_json)),
  native_leaf_id TEXT CHECK(native_leaf_id IS NULL),
  created_at TEXT NOT NULL,
  UNIQUE(id,session_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  CHECK(input_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO answers_p5(id,run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at) SELECT id,run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at FROM answers;
DROP TRIGGER model_calls_owner_insert; DROP TRIGGER model_calls_owner_update;
DROP TRIGGER tool_calls_model_owner_insert; DROP TRIGGER tool_calls_model_owner_update;
DROP TRIGGER queries_update_immutable; DROP TRIGGER queries_delete_immutable;
DROP TABLE answers;
DROP TABLE queries;
DROP TABLE model_calls;
DROP TABLE runs;
ALTER TABLE runs_p5 RENAME TO runs;
ALTER TABLE model_calls_p5 RENAME TO model_calls;
ALTER TABLE queries_p5 RENAME TO queries;
ALTER TABLE answers_p5 RENAME TO answers;
CREATE UNIQUE INDEX runs_one_root ON runs((1))
  WHERE kind IN ('provider','agent') AND status IN ('created','running');
CREATE UNIQUE INDEX runs_provider_operation_ref
  ON runs(json_extract(config_json,'$.providerRequest.operationRef')) WHERE kind='provider';
CREATE INDEX runs_session_recent ON runs(session_id,id DESC) WHERE kind='agent';
CREATE INDEX model_calls_run ON model_calls(run_id,id);

CREATE TRIGGER model_calls_owner_insert BEFORE INSERT ON model_calls
WHEN NEW.run_id IS NOT NULL
 AND NEW.session_id IS NOT (SELECT session_id FROM runs WHERE id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'model_call_owner_mismatch'); END;
CREATE TRIGGER model_calls_owner_update BEFORE UPDATE OF run_id,session_id ON model_calls
WHEN NEW.run_id IS NOT NULL
 AND NEW.session_id IS NOT (SELECT session_id FROM runs WHERE id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'model_call_owner_mismatch'); END;
CREATE INDEX queries_session_created ON queries(session_id,id);
CREATE TRIGGER tool_calls_model_owner_insert BEFORE INSERT ON tool_calls
WHEN NEW.model_call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM model_calls WHERE id=NEW.model_call_id AND run_id=NEW.run_id AND session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'tool_model_owner_mismatch'); END;
CREATE TRIGGER tool_calls_model_owner_update BEFORE UPDATE OF model_call_id,run_id,session_id ON tool_calls
WHEN NEW.model_call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM model_calls WHERE id=NEW.model_call_id AND run_id=NEW.run_id AND session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'tool_model_owner_mismatch'); END;
CREATE TRIGGER queries_update_immutable BEFORE UPDATE ON queries
BEGIN SELECT RAISE(ABORT,'query_immutable'); END;
CREATE TRIGGER queries_delete_immutable BEFORE DELETE ON queries
BEGIN SELECT RAISE(ABORT,'query_immutable'); END;

CREATE TRIGGER session_inputs_identity_immutable BEFORE UPDATE ON session_inputs
WHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.client_sequence IS NOT OLD.client_sequence
 OR NEW.operation_ref IS NOT OLD.operation_ref OR NEW.mode IS NOT OLD.mode OR NEW.created_at IS NOT OLD.created_at
 OR json_remove(NEW.content_json,'$.deliveryAttempt') IS NOT json_remove(OLD.content_json,'$.deliveryAttempt')
 OR (json_type(OLD.content_json,'$.deliveryAttempt') IS NOT 'null' AND json_extract(NEW.content_json,'$.deliveryAttempt') IS NOT json_extract(OLD.content_json,'$.deliveryAttempt'))
 OR (NEW.target_run_id IS NOT OLD.target_run_id AND NOT (OLD.target_run_id IS NULL AND NEW.mode='send' AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.target_run_id AND session_id=NEW.session_id AND input_id=NEW.id)))
BEGIN SELECT RAISE(ABORT,'input_identity_immutable'); END;
CREATE TRIGGER session_inputs_delete_immutable BEFORE DELETE ON session_inputs
BEGIN SELECT RAISE(ABORT,'input_immutable'); END;
