BEGIN;

ALTER TABLE condominiums
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS scae_present BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE condominiums
SET scae_present=TRUE
WHERE scae_condominium_id IS NOT NULL;

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS scae_present BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE units
SET scae_present=TRUE
WHERE scae_installation_point_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_condominiums_active
  ON condominiums(active);
CREATE INDEX IF NOT EXISTS idx_condominiums_scae_present
  ON condominiums(scae_present)
  WHERE scae_condominium_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_units_active
  ON units(active);
CREATE INDEX IF NOT EXISTS idx_units_scae_present
  ON units(scae_present)
  WHERE scae_installation_point_id IS NOT NULL;

-- Proteção permanente: customer_accounts.owner_user_id pode ser NULL.
-- A comparação SQL (user_id = NULL) resulta em NULL, mas is_owner é NOT NULL.
CREATE OR REPLACE FUNCTION hidrocondo_account_members_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.is_owner := COALESCE(NEW.is_owner, FALSE);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_account_members_owner_guard ON account_members;
CREATE TRIGGER trg_account_members_owner_guard
BEFORE INSERT OR UPDATE OF is_owner ON account_members
FOR EACH ROW
EXECUTE FUNCTION hidrocondo_account_members_owner_guard();

-- Corrige preventivamente qualquer linha antiga caso a constraint tenha sido
-- temporariamente relaxada em alguma instalação.
UPDATE account_members SET is_owner=FALSE WHERE is_owner IS NULL;

COMMIT;
