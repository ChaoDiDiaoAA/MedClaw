CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  native_session_id TEXT NOT NULL UNIQUE CHECK(length(native_session_id)>0),
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind='user'),
  creation_operation_ref TEXT NOT NULL UNIQUE CHECK(length(creation_operation_ref)>0),
  creation_request_json TEXT NOT NULL
    CHECK(json_valid(creation_request_json)) CHECK(json_type(creation_request_json) IS 'object'),
  creation_result_json TEXT NOT NULL
    CHECK(json_valid(creation_result_json)) CHECK(json_type(creation_result_json) IS 'object'),
  title TEXT NOT NULL CHECK(length(trim(title))>0),
  storage_version INTEGER NOT NULL DEFAULT 0 CHECK(storage_version=0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status='active'),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(metadata_json)) CHECK(json_type(metadata_json) IS 'object')
) STRICT;

CREATE TABLE workspace (
  id INTEGER PRIMARY KEY CHECK(id=1),
  active_session_id INTEGER REFERENCES sessions(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs_p2 (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id), input_id INTEGER CHECK(input_id IS NULL),
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
    (kind='provider' AND session_id IS NULL AND submission_operation_ref IS NULL
      AND submission_client_sequence IS NULL AND submission_request_json IS NULL)
    OR
    (kind='agent' AND session_id IS NOT NULL
      AND submission_operation_ref IS NOT NULL AND length(submission_operation_ref)>0
      AND submission_client_sequence IS NOT NULL AND submission_client_sequence>0
      AND submission_request_json IS NOT NULL
      AND json_type(submission_request_json) IS 'object'
      AND json_type(submission_request_json,'$.sessionId') IS 'integer'
      AND json_extract(submission_request_json,'$.sessionId')=session_id
      AND json_type(submission_request_json,'$.clientSequence') IS 'integer'
      AND json_extract(submission_request_json,'$.clientSequence')=submission_client_sequence
      AND workspace_json IS NOT NULL)
  ),
  CHECK(kind<>'provider' OR
    (json_type(config_json,'$.providerRequest') IS 'object'
     AND json_type(config_json,'$.providerRequest.operationRef') IS 'text'
     AND length(json_extract(config_json,'$.providerRequest.operationRef'))>0)),
  CHECK(kind<>'agent' OR
    (json_type(config_json,'$.agent') IS 'object'
     AND json_type(config_json,'$.agent.nativeSessionId') IS 'text'))
) STRICT;

CREATE TABLE model_calls_p2 (
  id INTEGER PRIMARY KEY, call_id TEXT NOT NULL UNIQUE,
  run_id INTEGER REFERENCES runs(id), session_id INTEGER REFERENCES sessions(id),
  input_id INTEGER CHECK(input_id IS NULL),
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
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id)
) STRICT;

INSERT INTO workspace(id,active_session_id,revision,updated_at) VALUES(1,NULL,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT INTO runs_p2(id,session_id,input_id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,
  scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json)
SELECT id,session_id,input_id,kind,prior_run_id,instance_id,status,goal,input_text,output_text,config_json,
  scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json FROM runs;
INSERT INTO model_calls_p2(id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,
  started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,cost_currency,usage_source,unavailable_reason,error_json)
SELECT id,call_id,run_id,session_id,input_id,kind,attempt,granularity,attempt_count_unknown,model_json,state,
  started_at,ended_at,duration_ms,input_tokens,output_tokens,cost,cost_currency,usage_source,unavailable_reason,error_json FROM model_calls;

DROP TABLE model_calls;
DROP TABLE runs;
ALTER TABLE runs_p2 RENAME TO runs;
ALTER TABLE model_calls_p2 RENAME TO model_calls;

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
