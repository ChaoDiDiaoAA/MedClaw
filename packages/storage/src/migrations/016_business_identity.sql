DROP TRIGGER exports_identity_immutable;
DROP TRIGGER session_inputs_identity_immutable;
DROP INDEX imports_fingerprint;
ALTER TABLE imports DROP COLUMN preview_request_hash;
ALTER TABLE imports DROP COLUMN commit_request_hash;
ALTER TABLE imports DROP COLUMN fingerprint;
ALTER TABLE batches DROP COLUMN source_lock_hash;
ALTER TABLE batches DROP COLUMN content_hash;
ALTER TABLE batches DROP COLUMN cohort_hash;
ALTER TABLE queries DROP COLUMN params_hash;
ALTER TABLE queries DROP COLUMN result_hash;
ALTER TABLE query_evidence DROP COLUMN source_lock_hash;
ALTER TABLE query_evidence DROP COLUMN result_hash;
ALTER TABLE query_contexts DROP COLUMN scope_batch_hashes_json;
ALTER TABLE exports DROP COLUMN request_hash;
ALTER TABLE exports DROP COLUMN published_hash;
ALTER TABLE exports ADD COLUMN request_json TEXT CHECK(request_json IS NULL OR json_valid(request_json));

CREATE TABLE artifacts_v16 (
  id INTEGER PRIMARY KEY,
  operation_ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('import','export')),
  import_id INTEGER REFERENCES imports(id),
  export_id INTEGER REFERENCES exports(id),
  query_id INTEGER REFERENCES queries(id),
  format TEXT NOT NULL,
  relative_path TEXT UNIQUE,
  bytes INTEGER CHECK(bytes IS NULL OR bytes>=0),
  published_at TEXT,
  registered_at TEXT,
  mime_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','ready')),
  CHECK((kind='import' AND import_id IS NOT NULL AND export_id IS NULL AND query_id IS NULL)
    OR (kind='export' AND export_id IS NOT NULL AND query_id IS NOT NULL AND import_id IS NULL)),
  CHECK((kind='import' AND format IN ('csv','xlsx')) OR (kind='export' AND format IN ('csv','json','markdown'))),
  CHECK(status<>'ready' OR (relative_path IS NOT NULL AND bytes IS NOT NULL AND registered_at IS NOT NULL))
) STRICT;
INSERT INTO artifacts_v16
  (id,operation_ref,kind,import_id,export_id,query_id,format,relative_path,bytes,published_at,registered_at,mime_type,metadata_json,status)
SELECT id,operation_ref,kind,import_id,export_id,query_id,format,relative_path,bytes,published_at,registered_at,mime_type,metadata_json,status FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_v16 RENAME TO artifacts;

CREATE TRIGGER exports_identity_immutable BEFORE UPDATE ON exports
WHEN NEW.id IS NOT OLD.id OR NEW.operation_ref IS NOT OLD.operation_ref
  OR NEW.prior_export_id IS NOT OLD.prior_export_id OR NEW.instance_id IS NOT OLD.instance_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.query_id IS NOT OLD.query_id
  OR NEW.answer_id IS NOT OLD.answer_id OR NEW.format IS NOT OLD.format
  OR NEW.request_json IS NOT OLD.request_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'export_identity_immutable'); END;


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
   AND OLD.status IN ('queued','delivery_unknown') AND NEW.status='consumed'
   AND NEW.run_id IS NEW.target_run_id AND NEW.native_entry_id IS NOT NULL))
 OR (NEW.target_run_id IS NOT OLD.target_run_id AND NOT (OLD.target_run_id IS NULL AND NEW.mode='send' AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.target_run_id AND session_id=NEW.session_id AND input_id=NEW.id)))
BEGIN SELECT RAISE(ABORT,'input_identity_immutable'); END;
