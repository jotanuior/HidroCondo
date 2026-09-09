BEGIN;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS responsible_user_id UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS ownership_started_at TIMESTAMPTZ;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_role TEXT;
ALTER TABLE alert_occurrence_events ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE alert_occurrence_events ADD COLUMN IF NOT EXISTS actor_role TEXT;

-- Existing rows keep their content; names are snapshotted from the available user record.
UPDATE audit_log a SET actor_name=u.name,actor_role=u.role FROM users u WHERE u.id=a.user_id AND a.actor_name IS NULL;
UPDATE alert_occurrence_events a SET actor_name=u.name,actor_role=u.role FROM users u WHERE u.id=a.actor_id AND a.actor_name IS NULL;
CREATE OR REPLACE FUNCTION audit_actor_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor UUID;
BEGIN
  IF TG_TABLE_NAME='audit_log' THEN actor:=NEW.user_id; ELSE actor:=NEW.actor_id; END IF;
  SELECT name,role INTO NEW.actor_name,NEW.actor_role FROM users WHERE id=actor;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Histórico de auditoria protegido: alteração, exclusão e limpeza não permitidas' USING ERRCODE='42501';
END $$;
CREATE TRIGGER audit_actor BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_actor_snapshot();
CREATE TRIGGER occurrence_actor BEFORE INSERT ON alert_occurrence_events FOR EACH ROW EXECUTE FUNCTION audit_actor_snapshot();
CREATE TRIGGER audit_no_mutation BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER occurrence_no_mutation BEFORE UPDATE OR DELETE ON alert_occurrence_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER occurrence_no_truncate BEFORE TRUNCATE ON alert_occurrence_events FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON audit_log,alert_occurrence_events FROM PUBLIC;
CREATE INDEX IF NOT EXISTS idx_audit_sensor ON audit_log(entity_type,entity_id,created_at DESC,id DESC);
COMMIT;
