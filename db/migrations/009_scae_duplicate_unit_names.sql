BEGIN;

-- Pontos de instalação distintos no SCAE podem ter a mesma descrição
-- dentro do mesmo condomínio (ex.: duas "Caixa Valencia").
-- Para unidades sincronizadas, a identidade é scae_installation_point_id.
-- Unidades criadas nativamente no HidroCondo continuam exigindo
-- identificador único dentro do bloco.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_building_id_identifier_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_units_native_building_identifier
  ON units(building_id, identifier)
  WHERE scae_installation_point_id IS NULL;

COMMIT;
