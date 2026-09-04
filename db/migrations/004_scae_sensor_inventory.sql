CREATE TABLE IF NOT EXISTS scae_sensor_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial TEXT NOT NULL UNIQUE,
  sensor_type TEXT NOT NULL DEFAULT '09',
  central_serial TEXT,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  scae_present BOOLEAN NOT NULL DEFAULT TRUE,
  administrative_status TEXT NOT NULL DEFAULT 'available'
    CHECK (administrative_status IN ('available','installed','inactive','maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scae_inventory_type ON scae_sensor_inventory(sensor_type);
CREATE INDEX IF NOT EXISTS idx_scae_inventory_present ON scae_sensor_inventory(scae_present);
CREATE INDEX IF NOT EXISTS idx_scae_inventory_status ON scae_sensor_inventory(administrative_status);
CREATE INDEX IF NOT EXISTS idx_scae_inventory_last_seen ON scae_sensor_inventory(last_seen_at DESC);
