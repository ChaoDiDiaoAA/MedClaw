CREATE UNIQUE INDEX model_calls_context_owner ON model_calls(id,run_id,session_id);

CREATE TABLE context_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  input_id INTEGER,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
    CHECK(json_type(snapshot_json)='object')
    CHECK(json_extract(snapshot_json,'$.contract') IS 'medclaw.context/v1'),
  created_at TEXT NOT NULL,
  UNIQUE(run_id,sequence),
  UNIQUE(id,run_id),
  UNIQUE(id,run_id,session_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(input_id,session_id) REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE context_deliveries (
  id INTEGER PRIMARY KEY,
  model_call_id INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  UNIQUE(model_call_id,snapshot_id),
  FOREIGN KEY(model_call_id,run_id,session_id) REFERENCES model_calls(id,run_id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(snapshot_id,run_id,session_id) REFERENCES context_snapshots(id,run_id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX context_deliveries_snapshot ON context_deliveries(snapshot_id);

ALTER TABLE tool_calls ADD COLUMN context_snapshot_id INTEGER REFERENCES context_snapshots(id);
CREATE INDEX tool_calls_context_snapshot ON tool_calls(context_snapshot_id) WHERE context_snapshot_id IS NOT NULL;

CREATE TRIGGER context_snapshot_input_owner BEFORE INSERT ON context_snapshots
WHEN NEW.input_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM session_inputs i WHERE i.id=NEW.input_id
    AND i.run_id=NEW.run_id AND i.session_id=NEW.session_id
    AND i.status='consumed' AND i.native_entry_id IS NOT NULL
) BEGIN SELECT RAISE(ABORT,'context_input_owner_mismatch'); END;
CREATE TRIGGER context_snapshot_no_update BEFORE UPDATE ON context_snapshots
BEGIN SELECT RAISE(ABORT,'context_snapshot_immutable'); END;
CREATE TRIGGER context_snapshot_no_delete BEFORE DELETE ON context_snapshots
BEGIN SELECT RAISE(ABORT,'context_snapshot_immutable'); END;
CREATE TRIGGER context_delivery_no_update BEFORE UPDATE ON context_deliveries
BEGIN SELECT RAISE(ABORT,'context_delivery_immutable'); END;
CREATE TRIGGER context_delivery_no_delete BEFORE DELETE ON context_deliveries
BEGIN SELECT RAISE(ABORT,'context_delivery_immutable'); END;

CREATE TRIGGER tool_context_owner_insert BEFORE INSERT ON tool_calls
WHEN NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_snapshots s JOIN model_calls c ON c.id=NEW.model_call_id
  WHERE s.id=NEW.context_snapshot_id AND s.run_id=NEW.run_id AND s.session_id=NEW.session_id
    AND c.run_id=NEW.run_id AND c.session_id=NEW.session_id
    AND json_extract(c.model_json,'$.context.snapshotId')=s.id
) BEGIN SELECT RAISE(ABORT,'tool_context_owner_mismatch'); END;
CREATE TRIGGER tool_context_immutable BEFORE UPDATE OF context_snapshot_id,model_call_id ON tool_calls
WHEN NEW.context_snapshot_id IS NOT OLD.context_snapshot_id
  OR (OLD.context_snapshot_id IS NOT NULL AND NEW.model_call_id IS NOT OLD.model_call_id)
BEGIN SELECT RAISE(ABORT,'tool_context_immutable'); END;
