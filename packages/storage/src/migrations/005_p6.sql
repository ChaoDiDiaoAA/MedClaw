CREATE TABLE runtime_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_connection TEXT,
  source_sequence INTEGER CHECK(source_sequence IS NULL OR source_sequence>=0),
  tool_call_id INTEGER REFERENCES tool_calls(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(run_id,sequence),
  UNIQUE(source_connection,source_sequence),
  CHECK((source_connection IS NULL AND source_sequence IS NULL)
     OR (source_connection IS NOT NULL AND source_sequence IS NOT NULL)),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
