CREATE TABLE route_decisions_new (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  input_id INTEGER NOT NULL,
  intent_call_id INTEGER,
  route TEXT NOT NULL CHECK(route IN ('simple','agent','clarify','reject')),
  decision_source TEXT NOT NULL CHECK(decision_source IN ('deterministic_rule','validated_model','user_form','explicit_agent_fallback')),
  matched_by TEXT CHECK(matched_by IN ('rule','qwen_prompt','paper_enhanced')),
  business_status TEXT CHECK(business_status IN ('RESOLVED','AMBIGUOUS','OUT_OF_SCOPE','UNSUPPORTED_DATA','NEED_PARAMETERS')),
  rule_evaluation_json TEXT CHECK(rule_evaluation_json IS NULL OR json_valid(rule_evaluation_json)),
  adopted_intents_json TEXT NOT NULL CHECK(json_valid(adopted_intents_json)),
  context_intent_id TEXT,
  adopted_slots_json TEXT CHECK(adopted_slots_json IS NULL OR json_valid(adopted_slots_json)),
  query_params_json TEXT CHECK(query_params_json IS NULL OR json_valid(query_params_json)),
  execution_plan_json TEXT CHECK(execution_plan_json IS NULL OR json_valid(execution_plan_json)),
  missing_slots_json TEXT NOT NULL CHECK(json_valid(missing_slots_json)),
  issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
  schema_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(route<>'simple' OR ((query_params_json IS NOT NULL OR execution_plan_json IS NOT NULL) AND business_status IS 'RESOLVED')),
  CHECK(route NOT IN ('simple','agent') OR decision_source IN ('user_form','explicit_agent_fallback') OR business_status IS 'RESOLVED'),
  CHECK((decision_source='deterministic_rule' AND intent_call_id IS NULL AND matched_by IS 'rule') OR
        (decision_source='validated_model' AND intent_call_id IS NOT NULL AND matched_by IS NOT NULL AND matched_by IN ('qwen_prompt','paper_enhanced')) OR
        (decision_source IN ('user_form','explicit_agent_fallback') AND intent_call_id IS NULL AND matched_by IS NULL)),
  CHECK(decision_source IN ('user_form','explicit_agent_fallback') OR business_status IS NOT NULL),
  FOREIGN KEY(run_id,session_id)
    REFERENCES runs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(input_id,session_id)
    REFERENCES session_inputs(id,session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(intent_call_id,run_id,session_id)
    REFERENCES intent_calls(id,run_id,session_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO route_decisions_new(id,run_id,session_id,input_id,intent_call_id,route,decision_source,matched_by,business_status,rule_evaluation_json,adopted_intents_json,context_intent_id,adopted_slots_json,query_params_json,missing_slots_json,issues_json,schema_version,policy_version,created_at) SELECT id,run_id,session_id,input_id,intent_call_id,route,decision_source,matched_by,business_status,rule_evaluation_json,adopted_intents_json,context_intent_id,adopted_slots_json,query_params_json,missing_slots_json,issues_json,schema_version,policy_version,created_at FROM route_decisions;

DROP TRIGGER route_decision_owner_insert;
DROP TRIGGER route_decision_immutable;
DROP TABLE route_decisions;
ALTER TABLE route_decisions_new RENAME TO route_decisions;
CREATE INDEX route_decisions_session ON route_decisions(session_id,id DESC);
CREATE TRIGGER route_decision_owner_insert BEFORE INSERT ON route_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id JOIN session_inputs i ON i.id=r.input_id
  WHERE r.id=NEW.run_id AND r.kind='agent' AND r.parent_run_id IS NULL AND s.kind='user'
    AND s.id=NEW.session_id AND i.id=NEW.input_id AND i.session_id=s.id AND i.target_run_id=r.id
) OR (NEW.intent_call_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM intent_calls c WHERE c.id=NEW.intent_call_id AND c.run_id=NEW.run_id
    AND c.session_id=NEW.session_id AND c.input_id=NEW.input_id
)) BEGIN SELECT RAISE(ABORT,'route_decision_owner_mismatch'); END;
CREATE TRIGGER route_decision_immutable BEFORE UPDATE ON route_decisions
BEGIN SELECT RAISE(ABORT,'route_decision_immutable'); END;
