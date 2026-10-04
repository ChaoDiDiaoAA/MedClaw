-- Controlled batch deletion; old identities/history remain, payload identities never recycle.
CREATE TABLE data_deletions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 operation_ref TEXT NOT NULL UNIQUE,
 instance_id TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
 commit_request_json TEXT CHECK(commit_request_json IS NULL OR json_valid(commit_request_json)),
 receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
 state TEXT NOT NULL CHECK(state IN ('ready','committed')),
 cleanup_json TEXT NOT NULL CHECK(json_valid(cleanup_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((state='committed')=(receipt_json IS NOT NULL))
) STRICT;

CREATE TABLE batches_v7 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  deleted_at TEXT,
  deletion_operation_ref TEXT REFERENCES data_deletions(operation_ref),
  CHECK((status='deleted')=(deleted_at IS NOT NULL AND deletion_operation_ref IS NOT NULL)),
  CHECK((is_baseline=1 AND previous_batch_id IS NULL) OR (is_baseline=0 AND previous_batch_id IS NOT NULL)),
  CHECK(observed_entity_count<=expected_entity_count)
) STRICT;
INSERT INTO batches_v7(id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at) SELECT id,import_id,scope_key,snapshot_date,region,material_version,source_bundle_id,source_lock_hash,content_hash,coverage,cohort_hash,expected_entity_count,observed_entity_count,declared_missing_json,metadata_json,is_baseline,previous_batch_id,catalog_revision,created_at FROM batches ORDER BY id;

CREATE TABLE devices_v7 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_device_id TEXT NOT NULL UNIQUE,
  source_bundle_id TEXT NOT NULL,
  source_submission_id TEXT NOT NULL,
  source_applicant TEXT,
  source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json)),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO devices_v7(id,source_device_id,source_bundle_id,source_submission_id,source_applicant,source_refs_json,created_at) SELECT id,source_device_id,source_bundle_id,source_submission_id,source_applicant,source_refs_json,created_at FROM devices ORDER BY id;

CREATE TABLE snapshots_v7 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO snapshots_v7(id,batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json) SELECT id,batch_id,device_id,device_name,category,region,price_cents,currency,unit,status,manufacturer,distributor,source_row_ref,source_refs_json,field_origins_json FROM snapshots ORDER BY id;

CREATE TABLE change_events_v7 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
INSERT INTO change_events_v7(id,event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,delta_cents,ratio,calculation_version,created_at) SELECT id,event_key,device_id,old_batch_id,new_batch_id,kind,field,old_value_json,new_value_json,delta_cents,ratio,calculation_version,created_at FROM change_events ORDER BY id;

DROP TABLE change_events;
DROP TABLE snapshots;
DROP TABLE batches;
DROP TABLE devices;
ALTER TABLE batches_v7 RENAME TO batches;
ALTER TABLE devices_v7 RENAME TO devices;
ALTER TABLE snapshots_v7 RENAME TO snapshots;
ALTER TABLE change_events_v7 RENAME TO change_events;
CREATE INDEX batches_import ON batches(import_id);
CREATE UNIQUE INDEX batches_active_scope_date ON batches(scope_key,snapshot_date) WHERE status='active';
CREATE INDEX batches_lifecycle ON batches(status,snapshot_date,id);
CREATE INDEX snapshots_device_batch ON snapshots(device_id,batch_id);
CREATE INDEX change_events_new_device ON change_events(new_batch_id,device_id);
