BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS scae_present BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET scae_present=TRUE WHERE scae_user_id IS NOT NULL;

ALTER TABLE user_condominiums
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HIDROCONDO';

ALTER TABLE access_grants
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HIDROCONDO';

ALTER TABLE account_members
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'HIDROCONDO';

-- Relações criadas pela integração antiga não possuíam marca de origem.
-- Fazemos backfill somente quando usuário e condomínio são exclusivamente SCAE;
-- vínculos de registros HIDROCONDO/HIDROCONDO+SCAE continuam preservados como manuais.
UPDATE user_condominiums uc
SET source='SCAE'
FROM users u, condominiums c
WHERE uc.user_id=u.id
  AND uc.condominium_id=c.id
  AND u.source='SCAE'
  AND c.source='SCAE';

UPDATE access_grants g
SET source='SCAE'
FROM users u, condominiums c
WHERE g.user_id=u.id
  AND g.scope_type='condominium'
  AND g.scope_id=c.id
  AND u.source='SCAE'
  AND c.source='SCAE';

UPDATE account_members am
SET source='SCAE'
FROM users u, condominiums c
WHERE am.user_id=u.id
  AND am.account_id=c.account_id
  AND u.source='SCAE'
  AND c.source='SCAE';

CREATE INDEX IF NOT EXISTS idx_user_condominiums_source
  ON user_condominiums(user_id,source);
CREATE INDEX IF NOT EXISTS idx_access_grants_source
  ON access_grants(user_id,source);
CREATE INDEX IF NOT EXISTS idx_account_members_source
  ON account_members(user_id,source);

COMMIT;
