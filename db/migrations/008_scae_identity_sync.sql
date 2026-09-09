BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS scae_user_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HIDROCONDO';
ALTER TABLE users ADD COLUMN IF NOT EXISTS scae_role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS scae_registration_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS scae_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_scae_user_id ON users(scae_user_id) WHERE scae_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_cpf_cnpj ON users(cpf_cnpj) WHERE cpf_cnpj IS NOT NULL;

ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS scae_condominium_id BIGINT;
ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HIDROCONDO';
ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS scae_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_condominiums_scae_id ON condominiums(scae_condominium_id) WHERE scae_condominium_id IS NOT NULL;

ALTER TABLE units ADD COLUMN IF NOT EXISTS scae_installation_point_id BIGINT;
ALTER TABLE units ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HIDROCONDO';
ALTER TABLE units ADD COLUMN IF NOT EXISTS scae_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_units_scae_point_id ON units(scae_installation_point_id) WHERE scae_installation_point_id IS NOT NULL;

ALTER TABLE sensors ADD COLUMN IF NOT EXISTS scae_sensor_id BIGINT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS scae_equipment_id BIGINT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HIDROCONDO';
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS scae_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sensors_scae_id ON sensors(scae_sensor_id) WHERE scae_sensor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scae_sync_log (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  received_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  merged_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
