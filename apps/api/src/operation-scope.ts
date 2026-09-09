// Bind $1 to superadmin, $2 to user id and $3 to allowed grant roles (null = read).
// Occurrences use their saved location, never the sensor's new installation.
export function scopePermission(alias: string): string {
  return `($1::boolean
    OR EXISTS(SELECT 1 FROM account_members am WHERE am.user_id=$2 AND am.account_id=${alias}.account_id
      AND ($3::text[] IS NULL OR am.role=ANY($3)))
    OR EXISTS(SELECT 1 FROM user_condominiums uc JOIN users usr ON usr.id=uc.user_id
      WHERE uc.user_id=$2 AND uc.condominium_id=${alias}.condominium_id
      AND ($3::text[] IS NULL OR usr.role=ANY($3)))
    OR EXISTS(SELECT 1 FROM access_grants g WHERE g.user_id=$2
      AND ($3::text[] IS NULL OR g.role=ANY($3)) AND (
        (g.scope_type='account' AND g.scope_id=${alias}.account_id)
        OR (g.scope_type='condominium' AND g.scope_id=${alias}.condominium_id)
        OR (g.scope_type='building' AND g.scope_id=${alias}.building_id)
        OR (g.scope_type='unit' AND g.scope_id=${alias}.unit_id)
        OR (g.scope_type='sensor' AND g.scope_id=${alias}.sensor_id))))`;
}

export const operationalSensors = `SELECT s.id sensor_id,s.serial,s.active,s.account_id,
  s.last_seen_at,s.last_reading_at,s.needs_review,s.created_at,s.claimed_at,s.virtual_counter,
  s.unit_id,u.identifier unit_identifier,b.id building_id,b.name building_name,
  c.id condominium_id,c.name condominium_name
  FROM sensors s LEFT JOIN units u ON u.id=s.unit_id
  LEFT JOIN buildings b ON b.id=u.building_id LEFT JOIN condominiums c ON c.id=b.condominium_id`;
