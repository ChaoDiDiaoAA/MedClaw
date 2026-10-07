-- Schema12 rebuild: original columns and user/root constraints are preserved.
CREATE TABLE sessions_p13 (
  id INTEGER PRIMARY KEY,
  native_session_id TEXT NOT NULL UNIQUE CHECK(length(native_session_id)>0),
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind IN ('user','child')),
  creation_operation_ref TEXT NOT NULL UNIQUE CHECK(length(creation_operation_ref)>0),
  creation_request_json TEXT NOT NULL CHECK(json_valid(creation_request_json)) CHECK(json_type(creation_request_json) IS 'object'),
  creation_result_json TEXT CHECK(creation_result_json IS NULL OR json_valid(creation_result_json)) CHECK(creation_result_json IS NULL OR json_type(creation_result_json) IS 'object'),
  title TEXT NOT NULL CHECK(length(trim(title))>0),
  storage_version INTEGER NOT NULL DEFAULT 0 CHECK(storage_version BETWEEN 0 AND 9007199254740991),
  native_header_json TEXT CHECK(native_header_json IS NULL OR json_valid(native_header_json)),
  current_leaf_id TEXT,
  history_format_version TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  metadata_json TEXT NOT NULL DEFAULT '{"titleOrigin":"default"}' CHECK(json_valid(metadata_json)) CHECK(json_type(metadata_json) IS 'object'),
  metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK(metadata_revision BETWEEN 0 AND 9007199254740991),
  deleted_at TEXT,
  CHECK((status='deleted')=(deleted_at IS NOT NULL)),
  CHECK(deleted_at IS NULL OR (length(deleted_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at) IS deleted_at)),
  CHECK((native_header_json IS NULL)=(history_format_version IS NULL)),
  CHECK(storage_version=0 OR native_header_json IS NOT NULL),
  CHECK(native_header_json IS NOT NULL OR current_leaf_id IS NULL),
  CHECK((kind='user' AND creation_result_json IS NOT NULL) OR
    (kind='child' AND creation_result_json IS NULL AND status='active'
      AND json_extract(creation_request_json,'$.contract') IS 'medclaw.child-creation/v1'
      AND json_type(creation_request_json,'$.parentRunId') IS 'integer'
      AND json_type(creation_request_json,'$.originToolCallId') IS 'integer'
      AND json_type(creation_request_json,'$.pluginAgentId') IS 'text'
      AND length(json_extract(creation_request_json,'$.pluginAgentId'))>0
      AND creation_operation_ref IS 'internal-child:'||json_extract(creation_request_json,'$.originToolCallId'))),
  FOREIGN KEY(id,current_leaf_id) REFERENCES memories(session_id,native_entry_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO sessions_p13(id,native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,native_header_json,current_leaf_id,history_format_version,created_at,updated_at,status,metadata_json,metadata_revision,deleted_at) SELECT id,native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,native_header_json,current_leaf_id,history_format_version,created_at,updated_at,status,metadata_json,metadata_revision,deleted_at FROM sessions;

CREATE TABLE runs_p13 (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id), input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('provider','agent','child')),
  parent_run_id INTEGER REFERENCES runs(id),
  origin_tool_call_id INTEGER REFERENCES tool_calls(id) DEFERRABLE INITIALLY DEFERRED,
  child_result_json TEXT CHECK(child_result_json IS NULL OR (json_valid(child_result_json) AND json_type(child_result_json) IS 'object')),
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
    OR (kind='child' AND input_id IS NULL AND session_id IS NOT NULL AND workspace_json IS NULL
      AND submission_operation_ref IS NULL AND submission_client_sequence IS NULL AND submission_request_json IS NULL
      AND prior_run_id IS NULL AND goal='answer')
  ),
  CHECK((kind IN ('provider','agent') AND parent_run_id IS NULL AND origin_tool_call_id IS NULL AND child_result_json IS NULL)
    OR (kind='child' AND parent_run_id IS NOT NULL AND parent_run_id<>id AND origin_tool_call_id IS NOT NULL
      AND json_extract(config_json,'$.subagent.contract') IS 'medclaw.subagent/v1'
      AND json_extract(config_json,'$.subagent.childRunId') IS id
      AND json_extract(config_json,'$.subagent.childSessionId') IS session_id
      AND json_extract(config_json,'$.subagent.parentRunId') IS parent_run_id
      AND json_extract(config_json,'$.subagent.originToolCallId') IS origin_tool_call_id
      AND json_extract(config_json,'$.subagent.instanceId') IS instance_id
      AND json_type(config_json,'$.subagent.nativeSessionId') IS 'text'
      AND json_type(config_json,'$.subagent.pluginAgentId') IS 'text'
      AND length(json_extract(config_json,'$.subagent.nativeSessionId'))>0
      AND length(json_extract(config_json,'$.subagent.pluginAgentId'))>0)),
  CHECK(kind<>'child' OR status<>'completed' OR child_result_json IS NOT NULL),
  CHECK(child_result_json IS NULL OR (kind='child' AND status IN ('completed','failed','cancelled')
    AND json_extract(child_result_json,'$.contract') IS 'medclaw.child-result/v1'
    AND json_extract(child_result_json,'$.childRunId') IS id
    AND json_extract(child_result_json,'$.childSessionId') IS session_id
    AND json_extract(child_result_json,'$.parentRunId') IS parent_run_id
    AND json_extract(child_result_json,'$.originToolCallId') IS origin_tool_call_id
    AND json_extract(child_result_json,'$.pluginAgentId') IS json_extract(config_json,'$.subagent.pluginAgentId')
    AND json_extract(child_result_json,'$.nativeSessionId') IS json_extract(config_json,'$.subagent.nativeSessionId')
    AND json_extract(child_result_json,'$.outcome') IS status)),
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
INSERT INTO runs_p13(id,session_id,input_id,kind,prior_run_id,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,output_text,config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json) SELECT id,session_id,input_id,kind,prior_run_id,instance_id,submission_operation_ref,submission_client_sequence,submission_request_json,status,goal,input_text,output_text,config_json,scope_json,workspace_json,reference_date,timezone,error_json,created_at,started_at,cancel_requested_at,stopped_at,ended_at,cleanup_json,usage_json FROM runs;

DROP TRIGGER model_calls_owner_insert;
DROP TRIGGER model_calls_owner_update;
DROP TRIGGER session_inputs_identity_immutable;
DROP TABLE runs;
DROP TABLE sessions;
ALTER TABLE sessions_p13 RENAME TO sessions;
ALTER TABLE runs_p13 RENAME TO runs;
CREATE INDEX sessions_user_status_id ON sessions(kind,status,id DESC);
CREATE UNIQUE INDEX runs_one_root ON runs((1))
  WHERE kind IN ('provider','agent') AND status IN ('created','running');
CREATE UNIQUE INDEX runs_provider_operation_ref
  ON runs(json_extract(config_json,'$.providerRequest.operationRef')) WHERE kind='provider';
CREATE INDEX runs_session_recent ON runs(session_id,id DESC) WHERE kind='agent';

CREATE TRIGGER model_calls_owner_insert BEFORE INSERT ON model_calls
WHEN NEW.run_id IS NOT NULL
 AND NEW.session_id IS NOT (SELECT session_id FROM runs WHERE id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'model_call_owner_mismatch'); END;
CREATE TRIGGER model_calls_owner_update BEFORE UPDATE OF run_id,session_id ON model_calls
WHEN NEW.run_id IS NOT NULL
 AND NEW.session_id IS NOT (SELECT session_id FROM runs WHERE id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'model_call_owner_mismatch'); END;
CREATE TRIGGER session_inputs_identity_immutable BEFORE UPDATE ON session_inputs
WHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.client_sequence IS NOT OLD.client_sequence
 OR NEW.operation_ref IS NOT OLD.operation_ref OR NEW.mode IS NOT OLD.mode OR NEW.created_at IS NOT OLD.created_at
 OR json_remove(NEW.content_json,'$.deliveryAttempt','$.nativeInput') IS NOT json_remove(OLD.content_json,'$.deliveryAttempt','$.nativeInput')
 OR (json_type(OLD.content_json,'$.deliveryAttempt') IS NOT 'null' AND json_extract(NEW.content_json,'$.deliveryAttempt') IS NOT json_extract(OLD.content_json,'$.deliveryAttempt'))
 OR (json_type(OLD.content_json,'$.nativeInput') IS NOT NULL AND json_extract(NEW.content_json,'$.nativeInput') IS NOT json_extract(OLD.content_json,'$.nativeInput'))
 OR (json_type(OLD.content_json,'$.nativeInput') IS NULL AND json_type(NEW.content_json,'$.nativeInput') IS NOT NULL AND NOT (
   json_type(NEW.content_json,'$.resourceInputPlan') IS 'object'
   AND json_type(NEW.content_json,'$.nativeInput') IS 'object'
   AND json_type(NEW.content_json,'$.nativeInput.text') IS 'text'
   AND json_type(NEW.content_json,'$.nativeInput.sha256') IS 'text'
   AND length(json_extract(NEW.content_json,'$.nativeInput.sha256'))=64
   AND OLD.status IN ('queued','delivery_unknown') AND NEW.status='consumed'
   AND NEW.run_id IS NEW.target_run_id AND NEW.native_entry_id IS NOT NULL))
 OR (NEW.target_run_id IS NOT OLD.target_run_id AND NOT (OLD.target_run_id IS NULL AND NEW.mode='send' AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.target_run_id AND session_id=NEW.session_id AND input_id=NEW.id)))
BEGIN SELECT RAISE(ABORT,'input_identity_immutable'); END;
CREATE UNIQUE INDEX runs_one_child ON runs((1)) WHERE kind='child' AND status IN ('created','running');
CREATE UNIQUE INDEX runs_child_origin ON runs(origin_tool_call_id) WHERE kind='child';
CREATE INDEX runs_parent_recent ON runs(parent_run_id,id DESC) WHERE kind='child';

CREATE TRIGGER sessions_child_identity_immutable BEFORE UPDATE ON sessions
WHEN (OLD.kind='child' OR NEW.kind='child') AND (NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
  OR NEW.native_session_id IS NOT OLD.native_session_id OR NEW.creation_operation_ref IS NOT OLD.creation_operation_ref
  OR NEW.creation_request_json IS NOT OLD.creation_request_json)
BEGIN SELECT RAISE(ABORT,'child_session_identity_immutable'); END;

CREATE TRIGGER runs_child_identity_immutable BEFORE UPDATE ON runs
WHEN (OLD.kind='child' OR NEW.kind='child') AND (NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
  OR NEW.instance_id IS NOT OLD.instance_id OR NEW.session_id IS NOT OLD.session_id
  OR NEW.parent_run_id IS NOT OLD.parent_run_id OR NEW.origin_tool_call_id IS NOT OLD.origin_tool_call_id
  OR json_extract(NEW.config_json,'$.subagent') IS NOT json_extract(OLD.config_json,'$.subagent')
  OR (OLD.child_result_json IS NOT NULL AND NEW.child_result_json IS NOT OLD.child_result_json))
BEGIN SELECT RAISE(ABORT,'child_run_identity_immutable'); END;

CREATE TRIGGER runs_child_owner_insert BEFORE INSERT ON runs
WHEN (NEW.kind='agent' AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND kind='user'))
 OR (NEW.kind='child' AND NOT EXISTS(
   SELECT 1 FROM runs p JOIN sessions s ON s.id=NEW.session_id JOIN tool_calls t ON t.id=NEW.origin_tool_call_id
   WHERE p.id=NEW.parent_run_id AND p.kind='agent' AND p.parent_run_id IS NULL
     AND p.session_id<>s.id AND p.instance_id=NEW.instance_id
     AND json_extract(NEW.config_json,'$.subagent.parentSessionId') IS p.session_id
     AND json_extract(NEW.config_json,'$.subagent.originNativeToolCallId') IS t.native_tool_call_id
     AND json_extract(NEW.config_json,'$.subagent.originSnapshotId') IS t.context_snapshot_id
     AND s.kind='child' AND s.native_session_id IS json_extract(NEW.config_json,'$.subagent.nativeSessionId')
     AND json_extract(s.creation_request_json,'$.parentRunId') IS p.id
     AND json_extract(s.creation_request_json,'$.originToolCallId') IS t.id
     AND json_extract(s.creation_request_json,'$.pluginAgentId') IS json_extract(NEW.config_json,'$.subagent.pluginAgentId')
     AND t.run_id=p.id AND t.session_id=p.session_id AND t.tool_name='Agent'))
BEGIN SELECT RAISE(ABORT,'child_owner_mismatch'); END;

CREATE TRIGGER runs_child_owner_update BEFORE UPDATE ON runs
WHEN (NEW.kind='agent' AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND kind='user'))
 OR (NEW.kind='child' AND NOT EXISTS(
   SELECT 1 FROM runs p JOIN sessions s ON s.id=NEW.session_id JOIN tool_calls t ON t.id=NEW.origin_tool_call_id
   WHERE p.id=NEW.parent_run_id AND p.kind='agent' AND p.parent_run_id IS NULL
     AND p.session_id<>s.id AND p.instance_id=NEW.instance_id
     AND json_extract(NEW.config_json,'$.subagent.parentSessionId') IS p.session_id
     AND json_extract(NEW.config_json,'$.subagent.originNativeToolCallId') IS t.native_tool_call_id
     AND json_extract(NEW.config_json,'$.subagent.originSnapshotId') IS t.context_snapshot_id
     AND s.kind='child' AND s.native_session_id IS json_extract(NEW.config_json,'$.subagent.nativeSessionId')
     AND json_extract(s.creation_request_json,'$.parentRunId') IS p.id
     AND json_extract(s.creation_request_json,'$.originToolCallId') IS t.id
     AND json_extract(s.creation_request_json,'$.pluginAgentId') IS json_extract(NEW.config_json,'$.subagent.pluginAgentId')
     AND t.run_id=p.id AND t.session_id=p.session_id AND t.tool_name='Agent'))
BEGIN SELECT RAISE(ABORT,'child_owner_mismatch'); END;
