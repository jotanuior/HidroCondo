BEGIN;

-- A conta SCAE pode não possuir owner_user_id definido. A expressão
-- (am.user_id = ca.owner_user_id) então resulta em NULL, mas is_owner é NOT NULL.
-- Este guard mantém a regra do banco íntegra e trata ausência de owner como false.
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

-- Normaliza preventivamente qualquer inconsistência herdada de ambientes antigos.
UPDATE account_members SET is_owner=FALSE WHERE is_owner IS NULL;

COMMIT;
