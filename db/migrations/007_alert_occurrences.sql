BEGIN;
CREATE TABLE IF NOT EXISTS alert_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL REFERENCES sensors(id) ON DELETE RESTRICT,
  rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  account_id UUID,
  condominium_id UUID,
  building_id UUID,
  unit_id UUID,
  serial TEXT NOT NULL,
  condominium_name TEXT,
  building_name TEXT,
  unit_identifier TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('offline','consumption','measurement_review')),
  title TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
  condition_active BOOLEAN NOT NULL DEFAULT true,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_active_condition
  ON alert_occurrences(sensor_id,kind,rule_key,scope_key) WHERE condition_active;
CREATE INDEX IF NOT EXISTS idx_alert_occurrences_opened ON alert_occurrences(opened_at DESC,id);
CREATE TABLE IF NOT EXISTS alert_occurrence_events (
  id BIGSERIAL PRIMARY KEY,
  occurrence_id UUID NOT NULL REFERENCES alert_occurrences(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_occurrence_events ON alert_occurrence_events(occurrence_id,created_at);
CREATE TABLE IF NOT EXISTS alert_evaluation_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_success_at TIMESTAMPTZ NOT NULL
);
COMMIT;
