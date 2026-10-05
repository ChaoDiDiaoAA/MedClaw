-- FK-off table rebuild is owned by openDatabase; every original column is copied.
CREATE TABLE sessions_p9 (
  id INTEGER PRIMARY KEY,
  native_session_id TEXT NOT NULL UNIQUE CHECK(length(native_session_id)>0),
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind='user'),
  creation_operation_ref TEXT NOT NULL UNIQUE CHECK(length(creation_operation_ref)>0),
  creation_request_json TEXT NOT NULL CHECK(json_valid(creation_request_json)) CHECK(json_type(creation_request_json) IS 'object'),
  creation_result_json TEXT NOT NULL CHECK(json_valid(creation_result_json)) CHECK(json_type(creation_result_json) IS 'object'),
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
  FOREIGN KEY(id,current_leaf_id) REFERENCES memories(session_id,native_entry_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO sessions_p9(id,native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,
  native_header_json,current_leaf_id,history_format_version,created_at,updated_at,status,metadata_json,metadata_revision,deleted_at)
SELECT id,native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,
  NULL,NULL,NULL,created_at,updated_at,status,metadata_json,metadata_revision,deleted_at FROM sessions;

CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  native_entry_id TEXT NOT NULL CHECK(length(native_entry_id)>0),
  parent_entry_id TEXT,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  entry_type TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  run_id INTEGER,
  recorded_at TEXT NOT NULL,
  UNIQUE(session_id,native_entry_id), UNIQUE(session_id,sequence),
  CHECK(parent_entry_id IS NULL OR parent_entry_id<>native_entry_id),
  CHECK(json_extract(entry_json,'$.id') IS native_entry_id),
  CHECK(json_extract(entry_json,'$.parentId') IS parent_entry_id),
  CHECK(json_extract(entry_json,'$.type') IS entry_type),
  FOREIGN KEY(session_id,parent_entry_id) REFERENCES memories(session_id,native_entry_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE answers_p9 (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  input_id INTEGER CHECK(input_id IS NULL OR input_id>0),
  kind TEXT NOT NULL CHECK(kind IN ('result','clarification','out_of_scope','insufficient_evidence')),
  text TEXT NOT NULL,
  query_ids_json TEXT NOT NULL CHECK(json_valid(query_ids_json)),
  missing_slots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(missing_slots_json)),
  native_leaf_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(id,session_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(session_id,native_leaf_id) REFERENCES memories(session_id,native_entry_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO answers_p9(id,run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at)
SELECT id,run_id,session_id,input_id,kind,text,query_ids_json,missing_slots_json,native_leaf_id,created_at FROM answers;
DROP TABLE answers;
DROP TABLE sessions;
ALTER TABLE sessions_p9 RENAME TO sessions;
ALTER TABLE answers_p9 RENAME TO answers;
CREATE INDEX sessions_user_status_id ON sessions(kind,status,id DESC);
