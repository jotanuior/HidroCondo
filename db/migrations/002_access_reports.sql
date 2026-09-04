BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin','admin','sindico','zelador','conselheiro','morador'));

CREATE TABLE IF NOT EXISTS access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('condominium','unit')),
  scope_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','sindico','zelador','conselheiro','morador')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, scope_type, scope_id, role)
);

CREATE INDEX IF NOT EXISTS idx_access_grants_user ON access_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_access_grants_scope ON access_grants(scope_type, scope_id);

INSERT INTO access_grants(user_id, scope_type, scope_id, role)
SELECT uc.user_id, 'condominium', uc.condominium_id,
       CASE WHEN u.role IN ('admin','sindico','zelador','conselheiro') THEN u.role ELSE 'conselheiro' END
FROM user_condominiums uc
JOIN users u ON u.id=uc.user_id
WHERE u.role <> 'superadmin'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS access_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('condominium','unit')),
  scope_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('sindico','zelador','conselheiro','morador')),
  invited_email TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_invitations_scope ON access_invitations(scope_type, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_invitations_active ON access_invitations(expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;

COMMIT;
