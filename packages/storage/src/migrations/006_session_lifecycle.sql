CREATE TABLE sessions_lifecycle (
  id INTEGER PRIMARY KEY,
  native_session_id TEXT NOT NULL UNIQUE CHECK(length(native_session_id)>0),
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind='user'),
  creation_operation_ref TEXT NOT NULL UNIQUE CHECK(length(creation_operation_ref)>0),
  creation_request_json TEXT NOT NULL CHECK(json_valid(creation_request_json)) CHECK(json_type(creation_request_json) IS 'object'),
  creation_result_json TEXT NOT NULL CHECK(json_valid(creation_result_json)) CHECK(json_type(creation_result_json) IS 'object'),
  title TEXT NOT NULL CHECK(length(trim(title))>0),
  storage_version INTEGER NOT NULL DEFAULT 0 CHECK(storage_version=0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  metadata_json TEXT NOT NULL DEFAULT '{"titleOrigin":"default"}' CHECK(json_valid(metadata_json)) CHECK(json_type(metadata_json) IS 'object'),
  metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK(metadata_revision BETWEEN 0 AND 9007199254740991),
  deleted_at TEXT,
  CHECK((status='deleted')=(deleted_at IS NOT NULL)),
  CHECK(deleted_at IS NULL OR (length(deleted_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at) IS deleted_at))
) STRICT;
INSERT INTO sessions_lifecycle(id,native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,created_at,updated_at,status,metadata_json)
SELECT id,native_session_id,kind,creation_operation_ref,creation_request_json,creation_result_json,title,storage_version,created_at,updated_at,status,
  CASE WHEN json_extract(metadata_json,'$.titleOrigin') IN ('default','user') THEN metadata_json
    ELSE json_set(metadata_json,'$.titleOrigin',CASE
      WHEN title IN ('New Session '||id,'新会话 '||id)
        AND json_extract(creation_result_json,'$.session.title')=title
        AND json_extract(creation_result_json,'$.session.id')=id
        AND json_extract(creation_result_json,'$.session.nativeSessionId')=native_session_id
      THEN 'default' ELSE 'user' END) END
FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_lifecycle RENAME TO sessions;
CREATE INDEX sessions_user_status_id ON sessions(kind,status,id DESC);
