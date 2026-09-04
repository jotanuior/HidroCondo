INSERT INTO users (name, email, password_hash, role)
VALUES ('Administrador HidroCondo', 'admin@hidrocondo.local', crypt('HidroCondo@2026', gen_salt('bf', 10)), 'superadmin')
ON CONFLICT (email) DO NOTHING;

WITH c AS (
  INSERT INTO condominiums (name, city, state)
  VALUES ('Residencial Demonstração', 'Itajaí', 'SC')
  ON CONFLICT DO NOTHING
  RETURNING id
), condo AS (
  SELECT id FROM c
  UNION ALL
  SELECT id FROM condominiums WHERE name = 'Residencial Demonstração' LIMIT 1
), b AS (
  INSERT INTO buildings (condominium_id, name)
  SELECT id, 'Bloco A' FROM condo
  WHERE NOT EXISTS (
    SELECT 1 FROM buildings WHERE condominium_id = condo.id AND name = 'Bloco A'
  )
  RETURNING id
), building AS (
  SELECT id FROM b
  UNION ALL
  SELECT b2.id FROM buildings b2 JOIN condo ON condo.id = b2.condominium_id WHERE b2.name = 'Bloco A' LIMIT 1
)
INSERT INTO units (building_id, identifier)
SELECT building.id, v.identifier
FROM building
CROSS JOIN (VALUES ('101'), ('102'), ('103'), ('104')) AS v(identifier)
ON CONFLICT (building_id, identifier) DO NOTHING;

INSERT INTO user_condominiums (user_id, condominium_id)
SELECT u.id, c.id
FROM users u CROSS JOIN condominiums c
WHERE u.email = 'admin@hidrocondo.local' AND c.name = 'Residencial Demonstração'
ON CONFLICT DO NOTHING;
