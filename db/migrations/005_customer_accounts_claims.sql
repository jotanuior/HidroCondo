BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

CREATE TABLE IF NOT EXISTS customer_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_members (
  account_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','sindico','zelador','conselheiro','morador')),
  is_owner BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,user_id)
);

ALTER TABLE condominiums ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES customer_accounts(id) ON DELETE RESTRICT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES customer_accounts(id) ON DELETE RESTRICT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS claimed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_condominiums_account ON condominiums(account_id);
CREATE INDEX IF NOT EXISTS idx_sensors_account ON sensors(account_id);
CREATE INDEX IF NOT EXISTS idx_account_members_user ON account_members(user_id);

CREATE TABLE IF NOT EXISTS sensor_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL REFERENCES sensors(id) ON DELETE RESTRICT,
  unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sensor_installation_active
  ON sensor_installations(sensor_id)
  WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sensor_installations_unit ON sensor_installations(unit_id,installed_at DESC);

ALTER TABLE access_grants DROP CONSTRAINT IF EXISTS access_grants_scope_type_check;
ALTER TABLE access_grants ADD CONSTRAINT access_grants_scope_type_check
  CHECK (scope_type IN ('account','condominium','building','unit','sensor'));

ALTER TABLE access_invitations DROP CONSTRAINT IF EXISTS access_invitations_scope_type_check;
ALTER TABLE access_invitations ADD CONSTRAINT access_invitations_scope_type_check
  CHECK (scope_type IN ('account','condominium','building','unit','sensor'));

ALTER TABLE access_invitations DROP CONSTRAINT IF EXISTS access_invitations_role_check;
ALTER TABLE access_invitations ADD CONSTRAINT access_invitations_role_check
  CHECK (role IN ('admin','sindico','zelador','conselheiro','morador'));

COMMIT;
