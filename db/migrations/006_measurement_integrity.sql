BEGIN;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS last_source_timestamp TIMESTAMPTZ;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS counter_digits INTEGER NOT NULL DEFAULT 6 CHECK (counter_digits IN (3,6));
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS max_flow_m3_hour NUMERIC CHECK (max_flow_m3_hour > 0);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
UPDATE sensors SET last_seen_at=last_reading_at WHERE last_seen_at IS NULL;
UPDATE sensors s SET last_source_timestamp=t.source_timestamp
FROM telemetry_readings t WHERE t.sensor_id=s.id AND t.received_at=s.last_reading_at
AND s.last_source_timestamp IS NULL;
-- Preserve readings even if a future endpoint accidentally attempts a hard delete.
ALTER TABLE telemetry_readings DROP CONSTRAINT IF EXISTS telemetry_readings_sensor_id_fkey;
ALTER TABLE telemetry_readings ADD CONSTRAINT telemetry_readings_sensor_id_fkey
  FOREIGN KEY (sensor_id) REFERENCES sensors(id) ON DELETE RESTRICT;
COMMIT;
