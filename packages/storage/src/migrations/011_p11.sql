-- P11 adds no table or column. Only the once-written native consumption receipt
-- is excluded from the immutable input identity, together with deliveryAttempt.
DROP TRIGGER session_inputs_identity_immutable;
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
   AND json_type(NEW.content_json,'$.nativeInput.sha256') IS 'text'
   AND length(json_extract(NEW.content_json,'$.nativeInput.sha256'))=64
   AND OLD.status IN ('queued','delivery_unknown') AND NEW.status='consumed'
   AND NEW.run_id IS NEW.target_run_id AND NEW.native_entry_id IS NOT NULL))
 OR (NEW.target_run_id IS NOT OLD.target_run_id AND NOT (OLD.target_run_id IS NULL AND NEW.mode='send' AND EXISTS(SELECT 1 FROM runs WHERE id=NEW.target_run_id AND session_id=NEW.session_id AND input_id=NEW.id)))
BEGIN SELECT RAISE(ABORT,'input_identity_immutable'); END;
