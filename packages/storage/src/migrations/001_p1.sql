PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK(version > 0),
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER CHECK(session_id IS NULL),
  input_id INTEGER CHECK(input_id IS NULL),
  kind TEXT NOT NULL CHECK(kind = 'provider'),
  prior_run_id INTEGER REFERENCES runs(id),
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('created', 'running', 'completed', 'failed', 'cancelled')),
  goal TEXT NOT NULL CHECK(goal IN ('answer', 'query', 'verify')),
  input_text TEXT NOT NULL,
  output_text TEXT,
  config_json TEXT NOT NULL
    CHECK(json_valid(config_json))
    CHECK(json_type(config_json, '$.providerRequest') IS 'object')
    CHECK(
      json_type(config_json, '$.providerRequest.operationRef') IS 'text'
      AND length(json_extract(config_json, '$.providerRequest.operationRef')) > 0
    ),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  workspace_json TEXT CHECK(workspace_json IS NULL OR json_valid(workspace_json)),
  reference_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  cancel_requested_at TEXT,
  stopped_at TEXT,
  ended_at TEXT,
  cleanup_json TEXT CHECK(cleanup_json IS NULL OR json_valid(cleanup_json)),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  CHECK(prior_run_id IS NULL OR prior_run_id <> id)
) STRICT;

CREATE UNIQUE INDEX runs_one_root ON runs((1))
  WHERE kind = 'provider' AND status IN ('created', 'running');

CREATE UNIQUE INDEX runs_provider_operation_ref
  ON runs(json_extract(config_json, '$.providerRequest.operationRef'));

CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  run_id INTEGER REFERENCES runs(id),
  session_id INTEGER CHECK(session_id IS NULL),
  input_id INTEGER CHECK(input_id IS NULL),
  kind TEXT NOT NULL CHECK(kind IN ('main', 'diagnostic')),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  granularity TEXT NOT NULL CHECK(granularity IN ('logical_request', 'http_attempt')),
  attempt_count_unknown INTEGER NOT NULL CHECK(attempt_count_unknown IN (0, 1)),
  model_json TEXT NOT NULL CHECK(json_valid(model_json)),
  state TEXT NOT NULL CHECK(state IN ('started', 'completed', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms REAL CHECK(duration_ms IS NULL OR duration_ms >= 0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  cost REAL CHECK(cost IS NULL OR cost >= 0),
  cost_currency TEXT,
  usage_source TEXT,
  unavailable_reason TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  CHECK(cost IS NULL OR (cost_currency IS NOT NULL AND length(trim(cost_currency)) > 0))
) STRICT;

CREATE INDEX model_calls_run ON model_calls(run_id, id);
