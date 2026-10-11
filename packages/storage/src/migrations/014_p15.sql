CREATE TABLE exports (
  id INTEGER PRIMARY KEY,
  operation_ref TEXT NOT NULL UNIQUE,
  prior_export_id INTEGER REFERENCES exports(id),
  instance_id TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  query_id INTEGER NOT NULL,
  answer_id INTEGER,
  format TEXT NOT NULL CHECK(format IN ('csv','json','markdown')),
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','published','registered','copying','completed','failed','cancelled','interrupted')),
  artifact_id INTEGER REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED,
  published_hash TEXT,
  copy_state TEXT NOT NULL DEFAULT 'not_started' CHECK(copy_state IN ('not_started','copying','verified','failed','unknown')),
  copy_receipt_json TEXT CHECK(copy_receipt_json IS NULL OR json_valid(copy_receipt_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(prior_export_id IS NULL OR prior_export_id<>id),
  CHECK(state<>'completed' OR (copy_state='verified' AND artifact_id IS NOT NULL AND copy_receipt_json IS NOT NULL)),
  FOREIGN KEY(query_id,session_id) REFERENCES queries(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(answer_id,session_id) REFERENCES answers(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX exports_query ON exports(query_id,id);

CREATE TABLE artifacts_p15 (
  id INTEGER PRIMARY KEY,
  operation_ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('import','export')),
  import_id INTEGER REFERENCES imports(id),
  export_id INTEGER REFERENCES exports(id),
  query_id INTEGER REFERENCES queries(id),
  format TEXT NOT NULL,
  relative_path TEXT UNIQUE,
  sha256 TEXT,
  bytes INTEGER CHECK(bytes IS NULL OR bytes>=0),
  metadata_sha256 TEXT,
  published_at TEXT,
  registered_at TEXT,
  mime_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','ready')),
  CHECK((kind='import' AND import_id IS NOT NULL AND export_id IS NULL AND query_id IS NULL)
    OR (kind='export' AND export_id IS NOT NULL AND query_id IS NOT NULL AND import_id IS NULL)),
  CHECK((kind='import' AND format IN ('csv','xlsx')) OR (kind='export' AND format IN ('csv','json','markdown'))),
  CHECK(status<>'ready' OR (relative_path IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL AND registered_at IS NOT NULL))
) STRICT;
INSERT INTO artifacts_p15
  (id,operation_ref,kind,import_id,format,relative_path,sha256,bytes,metadata_sha256,published_at,registered_at,mime_type,metadata_json,status)
SELECT id,operation_ref,kind,import_id,format,relative_path,sha256,bytes,metadata_sha256,published_at,registered_at,mime_type,metadata_json,status FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_p15 RENAME TO artifacts;
ALTER TABLE business_events ADD COLUMN export_id INTEGER REFERENCES exports(id);

CREATE TRIGGER exports_identity_immutable BEFORE UPDATE ON exports
WHEN NEW.id IS NOT OLD.id OR NEW.operation_ref IS NOT OLD.operation_ref
  OR NEW.prior_export_id IS NOT OLD.prior_export_id OR NEW.instance_id IS NOT OLD.instance_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.query_id IS NOT OLD.query_id
  OR NEW.answer_id IS NOT OLD.answer_id OR NEW.format IS NOT OLD.format
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'export_identity_immutable'); END;

CREATE TRIGGER exports_terminal_immutable BEFORE UPDATE ON exports
WHEN OLD.state IN ('completed','failed','cancelled','interrupted')
  AND (NEW.state IS NOT OLD.state OR NEW.error_json IS NOT OLD.error_json
    OR NEW.copy_state IS NOT OLD.copy_state OR NEW.copy_receipt_json IS NOT OLD.copy_receipt_json)
BEGIN SELECT RAISE(ABORT,'export_terminal_immutable'); END;
