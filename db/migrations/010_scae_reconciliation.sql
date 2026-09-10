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

CREATE INDEX IF NOT EXISTS idx_user_condominiums_source
  ON user_condominiums(user_id,source);
CREATE INDEX IF NOT EXISTS idx_access_grants_source
  ON access_grants(user_id,source);
CREATE INDEX IF NOT EXISTS idx_account_members_source
  ON account_members(user_id,source);

COMMIT;
