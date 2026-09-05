import type { Express, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const adjustmentSchema = z.object({
  reading_m3: z.coerce.number().finite().min(0).max(999999999999),
  reason: z.string().trim().min(3).max(500)
});

function canAdjustRole(role: string | undefined) {
  return ['superadmin','admin','sindico'].includes(role ?? '');
}

function forbidden(res: Response) {
  return res.status(403).json({ error: 'Sem permissão para ajustar a leitura do hidrômetro' });
}

async function sensorAccess(req: AuthenticatedRequest, sensorId: string) {
  const result = await pool.query(
    `SELECT s.id,s.serial,s.virtual_counter,s.last_raw_value,s.unit_id,s.account_id,
            c.id condominium_id,c.name condominium_name,b.id building_id,b.name building_name,u.identifier unit_identifier
       FROM sensors s
       LEFT JOIN units u ON u.id=s.unit_id
       LEFT JOIN buildings b ON b.id=u.building_id
       LEFT JOIN condominiums c ON c.id=b.condominium_id
      WHERE s.id=$1`, [sensorId]
  );
  if (!result.rowCount) return { sensor: null, allowed: false };
  const sensor = result.rows[0];
  if (req.auth?.role === 'superadmin') return { sensor, allowed: true };

  const access = await pool.query(`SELECT 1 WHERE
       $2::uuid IN(SELECT account_id FROM account_members WHERE user_id=$1 AND role IN ('admin','sindico'))
    OR $2::uuid IN(SELECT scope_id FROM access_grants WHERE user_id=$1 AND scope_type='account' AND role IN ('admin','sindico'))
    OR $3::uuid IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$1)
    OR $3::uuid IN(SELECT scope_id FROM access_grants WHERE user_id=$1 AND scope_type='condominium' AND role IN ('admin','sindico'))
    OR $4::uuid IN(SELECT scope_id FROM access_grants WHERE user_id=$1 AND scope_type='building' AND role IN ('admin','sindico'))
    OR $5::uuid IN(SELECT scope_id FROM access_grants WHERE user_id=$1 AND scope_type='unit' AND role IN ('admin','sindico'))
    OR $6::uuid IN(SELECT scope_id FROM access_grants WHERE user_id=$1 AND scope_type='sensor' AND role IN ('admin','sindico'))`,
    [req.auth!.sub,sensor.account_id,sensor.condominium_id,sensor.building_id,sensor.unit_id,sensor.id]
  );
  return { sensor, allowed: access.rowCount === 1 };
}

export function registerCounterRoutes(app: Express) {
  app.post('/api/v1/sensores/:id/leitura-hidrometro', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!canAdjustRole(req.auth?.role)) return forbidden(res);
    const parsed = adjustmentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Informe uma leitura válida e uma justificativa' });

    const { sensor, allowed } = await sensorAccess(req, req.params.id);
    if (!sensor) return res.status(404).json({ error: 'Sensor não encontrado' });
    if (!allowed) return forbidden(res);

    const previous = Number(sensor.virtual_counter ?? 0);
    const next = parsed.data.reading_m3;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE sensors SET virtual_counter=$2 WHERE id=$1', [sensor.id, next]);
      await client.query(`INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
         VALUES($1,'meter_reading_adjustment','sensor',$2,$3::jsonb)`, [req.auth!.sub,sensor.id,JSON.stringify({
        serial:sensor.serial,condominium_id:sensor.condominium_id,condominium_name:sensor.condominium_name,
        building_name:sensor.building_name,unit_identifier:sensor.unit_identifier,
        previous_reading_m3:previous,new_reading_m3:next,raw_sensor_value:sensor.last_raw_value,reason:parsed.data.reason
      })]);
      await client.query('COMMIT');
      res.json({ok:true,sensor_id:sensor.id,serial:sensor.serial,previous_reading_m3:previous,reading_m3:next,raw_sensor_value:sensor.last_raw_value});
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  app.get('/api/v1/sensores/:id/ajustes-leitura', requireAuth, async (req: AuthenticatedRequest, res) => {
    const { sensor, allowed } = await sensorAccess(req, req.params.id);
    if (!sensor) return res.status(404).json({ error: 'Sensor não encontrado' });
    if (!allowed) return forbidden(res);
    const result = await pool.query(`SELECT a.id,a.created_at,a.payload,u.name user_name,u.email user_email
       FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.entity_type='sensor' AND a.entity_id=$1 AND a.action='meter_reading_adjustment'
      ORDER BY a.created_at DESC LIMIT 100`, [sensor.id]);
    res.json(result.rows);
  });
}
