CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  operation_ref TEXT NOT NULL UNIQUE CHECK(length(operation_ref)>0),
  prior_import_id INTEGER REFERENCES imports(id),
  instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','ready','committing','imported','duplicate','rejected','failed','cancelled','interrupted')),
  preview_request_hash TEXT NOT NULL,
  preview_request_json TEXT NOT NULL CHECK(json_valid(preview_request_json)),
  commit_request_hash TEXT,
  commit_request_json TEXT CHECK(commit_request_json IS NULL OR json_valid(commit_request_json)),
  fingerprint TEXT,
  preview_json TEXT CHECK(preview_json IS NULL OR json_valid(preview_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  manifest_path TEXT,
  artifact_id INTEGER REFERENCES artifacts(id) DEFERRABLE INITIALLY DEFERRED,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(prior_import_id IS NULL OR prior_import_id<>id)
) STRICT;
CREATE INDEX imports_fingerprint ON imports(fingerprint);

CREATE TABLE catalog_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO catalog_state(id,revision,updated_at) VALUES(1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  scope_key TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  region TEXT NOT NULL,
  material_version TEXT NOT NULL,
  source_bundle_id TEXT NOT NULL,
  source_lock_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage='full'),
  cohort_hash TEXT NOT NULL,
  expected_entity_count INTEGER NOT NULL CHECK(expected_entity_count>=0),
  observed_entity_count INTEGER NOT NULL CHECK(observed_entity_count>=0),
  declared_missing_json TEXT NOT NULL CHECK(json_valid(declared_missing_json)),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  is_baseline INTEGER NOT NULL CHECK(is_baseline IN (0,1)),
  previous_batch_id INTEGER REFERENCES batches(id),
  catalog_revision INTEGER NOT NULL CHECK(catalog_revision>0),
  created_at TEXT NOT NULL,
  UNIQUE(scope_key,snapshot_date),
  CHECK((is_baseline=1 AND previous_batch_id IS NULL) OR (is_baseline=0 AND previous_batch_id IS NOT NULL)),
  CHECK(observed_entity_count<=expected_entity_count)
) STRICT;
CREATE INDEX batches_import ON batches(import_id);

CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  source_device_id TEXT NOT NULL UNIQUE,
  source_bundle_id TEXT NOT NULL,
  source_submission_id TEXT NOT NULL,
  source_applicant TEXT,
  source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  device_id INTEGER NOT NULL REFERENCES devices(id),
  device_name TEXT NOT NULL,
  category TEXT,
  region TEXT NOT NULL,
  price_cents INTEGER CHECK(price_cents IS NULL OR price_cents>=0),
  currency TEXT NOT NULL CHECK(currency='CNY'),
  unit TEXT NOT NULL,
  status TEXT CHECK(status IS NULL OR status IN ('active','suspended','delisted','recalled')),
  manufacturer TEXT,
  distributor TEXT,
  source_row_ref TEXT NOT NULL,
  source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json)),
  field_origins_json TEXT NOT NULL CHECK(json_valid(field_origins_json)),
  UNIQUE(batch_id,device_id)
) STRICT;
CREATE INDEX snapshots_device_batch ON snapshots(device_id,batch_id);

CREATE TABLE change_events (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  old_batch_id INTEGER NOT NULL REFERENCES batches(id),
  new_batch_id INTEGER NOT NULL REFERENCES batches(id),
  kind TEXT NOT NULL CHECK(kind IN ('added','missing','field_changed')),
  field TEXT CHECK(field IN ('price','status','distributor')),
  old_value_json TEXT CHECK(old_value_json IS NULL OR json_valid(old_value_json)),
  new_value_json TEXT CHECK(new_value_json IS NULL OR json_valid(new_value_json)),
  delta_cents INTEGER,
  ratio REAL,
  calculation_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(old_batch_id<>new_batch_id),
  CHECK((kind='field_changed' AND field IS NOT NULL) OR (kind IN ('added','missing') AND field IS NULL))
) STRICT;
CREATE INDEX change_events_new_device ON change_events(new_batch_id,device_id);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  run_id INTEGER NOT NULL,
  native_tool_call_id TEXT NOT NULL CHECK(length(native_tool_call_id)>0),
  model_call_id INTEGER REFERENCES model_calls(id),
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
  stopped_at TEXT,
  UNIQUE(session_id,native_tool_call_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  CHECK((status IN ('requested','running') AND result_json IS NULL AND error_json IS NULL AND ended_at IS NULL)
    OR (status='succeeded' AND result_json IS NOT NULL AND error_json IS NULL AND ended_at IS NOT NULL)
    OR (status IN ('failed','cancelled') AND error_json IS NOT NULL AND ended_at IS NOT NULL))
) STRICT;
CREATE INDEX tool_calls_run ON tool_calls(run_id,id);

CREATE TABLE queries (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  run_id INTEGER NOT NULL,
  input_id INTEGER CHECK(input_id IS NULL),
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
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id)
) STRICT;
CREATE INDEX queries_session_created ON queries(session_id,id);

CREATE TABLE query_evidence (
  id INTEGER PRIMARY KEY,
  query_id INTEGER NOT NULL REFERENCES queries(id),
  batch_ids_json TEXT NOT NULL CHECK(json_valid(batch_ids_json)),
  snapshot_ids_json TEXT NOT NULL CHECK(json_valid(snapshot_ids_json)),
  event_ids_json TEXT NOT NULL CHECK(json_valid(event_ids_json)),
  source_row_refs_json TEXT NOT NULL CHECK(json_valid(source_row_refs_json)),
  filters_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(filters_json)),
  calculation_version TEXT NOT NULL,
  material_version TEXT NOT NULL,
  source_bundle_id TEXT NOT NULL,
  source_lock_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'synthetic-derived' CHECK(provenance IN ('public','synthetic','synthetic-derived'))
) STRICT;
CREATE INDEX query_evidence_query ON query_evidence(query_id,id);

CREATE TABLE answers (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  input_id INTEGER CHECK(input_id IS NULL),
  kind TEXT NOT NULL CHECK(kind IN ('result','clarification','out_of_scope','insufficient_evidence')),
  text TEXT NOT NULL,
  query_ids_json TEXT NOT NULL CHECK(json_valid(query_ids_json)),
  missing_slots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(missing_slots_json)),
  native_leaf_id TEXT CHECK(native_leaf_id IS NULL),
  created_at TEXT NOT NULL,
  UNIQUE(id,session_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id)
) STRICT;

CREATE TABLE business_events (
  id INTEGER PRIMARY KEY,
  operation_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('user','agent','system')),
  session_id INTEGER REFERENCES sessions(id),
  run_id INTEGER,
  import_id INTEGER REFERENCES imports(id),
  query_id INTEGER REFERENCES queries(id),
  artifact_id INTEGER REFERENCES artifacts(id),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE(operation_ref,type),
  CHECK(run_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id)
) STRICT;
CREATE INDEX business_events_query ON business_events(query_id,id);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY,
  operation_ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind='import'),
  import_id INTEGER NOT NULL REFERENCES imports(id),
  format TEXT NOT NULL CHECK(format='csv'),
  relative_path TEXT UNIQUE,
  sha256 TEXT,
  bytes INTEGER CHECK(bytes IS NULL OR bytes>=0),
  metadata_sha256 TEXT,
  published_at TEXT,
  registered_at TEXT,
  mime_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','ready')),
  CHECK(status<>'ready' OR (relative_path IS NOT NULL AND bytes IS NOT NULL AND sha256 IS NOT NULL AND registered_at IS NOT NULL))
) STRICT;

ALTER TABLE workspace ADD COLUMN material_version TEXT;
ALTER TABLE workspace ADD COLUMN batch_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(batch_refs_json));
ALTER TABLE workspace ADD COLUMN device_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(device_ids_json));
ALTER TABLE workspace ADD COLUMN active_query_id INTEGER REFERENCES queries(id);
ALTER TABLE workspace ADD COLUMN active_view TEXT NOT NULL DEFAULT 'data';
ALTER TABLE workspace ADD COLUMN selection_json TEXT CHECK(selection_json IS NULL OR json_valid(selection_json));

CREATE TRIGGER tool_calls_model_owner_insert BEFORE INSERT ON tool_calls
WHEN NEW.model_call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM model_calls WHERE id=NEW.model_call_id AND run_id=NEW.run_id AND session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'tool_model_owner_mismatch'); END;
CREATE TRIGGER tool_calls_model_owner_update BEFORE UPDATE OF model_call_id,run_id,session_id ON tool_calls
WHEN NEW.model_call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM model_calls WHERE id=NEW.model_call_id AND run_id=NEW.run_id AND session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'tool_model_owner_mismatch'); END;
CREATE TRIGGER tool_calls_identity_immutable BEFORE UPDATE ON tool_calls
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.native_tool_call_id IS NOT OLD.native_tool_call_id OR NEW.tool_name IS NOT OLD.tool_name
  OR NEW.tool_version IS NOT OLD.tool_version OR NEW.effect IS NOT OLD.effect
  OR NEW.execution_mode IS NOT OLD.execution_mode OR NEW.args_json IS NOT OLD.args_json
BEGIN SELECT RAISE(ABORT,'tool_identity_immutable'); END;
CREATE TRIGGER tool_calls_terminal_immutable BEFORE UPDATE ON tool_calls
WHEN OLD.status IN ('succeeded','failed','cancelled') AND (NEW.status IS NOT OLD.status
  OR NEW.result_json IS NOT OLD.result_json OR NEW.error_json IS NOT OLD.error_json
  OR NEW.started_at IS NOT OLD.started_at OR NEW.ended_at IS NOT OLD.ended_at)
BEGIN SELECT RAISE(ABORT,'tool_terminal_immutable'); END;
CREATE TRIGGER queries_update_immutable BEFORE UPDATE ON queries
BEGIN SELECT RAISE(ABORT,'query_immutable'); END;
CREATE TRIGGER queries_delete_immutable BEFORE DELETE ON queries
BEGIN SELECT RAISE(ABORT,'query_immutable'); END;
CREATE TRIGGER query_evidence_update_immutable BEFORE UPDATE ON query_evidence
BEGIN SELECT RAISE(ABORT,'query_evidence_immutable'); END;
CREATE TRIGGER query_evidence_delete_immutable BEFORE DELETE ON query_evidence
BEGIN SELECT RAISE(ABORT,'query_evidence_immutable'); END;
