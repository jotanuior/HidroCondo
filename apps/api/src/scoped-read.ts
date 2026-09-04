import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid = z.string().uuid();

const allowedUnitsSql = `
  SELECT u.id unit_id,u.identifier unit_identifier,b.id building_id,b.name building_name,
         c.id condominium_id,c.name condominium_name
    FROM units u
    JOIN buildings b ON b.id=u.building_id
    JOIN condominiums c ON c.id=b.condominium_id
   WHERE $1::boolean
      OR (c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
          AND EXISTS(SELECT 1 FROM users ux WHERE ux.id=$2 AND ux.role<>'morador'))
      OR c.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
      OR u.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit')`;

const sensorScopeSql = `
  SELECT s.id sensor_id,s.serial,s.sensor_type,s.central_serial,s.conversion_factor,s.active,
         s.last_raw_value,s.last_reading_at,s.virtual_counter,s.unit_id,
         au.unit_identifier,au.building_id,au.building_name,au.condominium_id,au.condominium_name
    FROM sensors s
    JOIN allowed_units au ON au.unit_id=s.unit_id`;

export function registerScopedReadRoutes(app: Express) {
  app.get('/api/v1/dashboard/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH allowed_units AS(${allowedUnitsSql}),ss AS(${sensorScopeSql})
      SELECT (SELECT COUNT(DISTINCT condominium_id) FROM allowed_units)::int condominiums,
             (SELECT COUNT(*) FROM allowed_units)::int units,
             COUNT(*)::int sensors,
             COUNT(*) FILTER(WHERE last_reading_at>=now()-interval '10 minutes')::int sensors_online,
             COUNT(*) FILTER(WHERE last_reading_at<now()-interval '30 minutes' OR last_reading_at IS NULL)::int sensors_offline,
             COALESCE((SELECT SUM(t.consumption_m3) FROM telemetry_readings t WHERE t.received_at>=date_trunc('month',now()) AND t.sensor_id IN(SELECT sensor_id FROM ss)),0)::float8 month_consumption_m3,
             COALESCE((SELECT SUM(t.consumption_m3) FROM telemetry_readings t WHERE t.received_at>=date_trunc('day',now()) AND t.sensor_id IN(SELECT sensor_id FROM ss)),0)::float8 today_consumption_m3
        FROM ss`, [req.auth!.role==='superadmin', req.auth!.sub]);
    res.json(q.rows[0]);
  });

  app.get('/api/v1/dashboard/series', requireAuth, async (req: AuthenticatedRequest, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14) || 14));
    const q = await pool.query(`WITH allowed_units AS(${allowedUnitsSql}),ss AS(${sensorScopeSql}),dates AS(
      SELECT generate_series(
        current_date - ($3::int - 1),
        current_date,
        interval '1 day'
      )::date AS day
    )
      SELECT d.day,COALESCE(SUM(t.consumption_m3),0)::float8 consumption_m3
        FROM dates d LEFT JOIN telemetry_readings t
          ON t.received_at>=d.day::timestamp AND t.received_at<(d.day+1)::timestamp
         AND t.sensor_id IN(SELECT sensor_id FROM ss)
       GROUP BY d.day ORDER BY d.day`, [req.auth!.role==='superadmin', req.auth!.sub, days]);
    res.json(q.rows);
  });

  app.get('/api/v1/condominios', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH allowed_units AS(${allowedUnitsSql})
      SELECT c.id,c.name,c.document,c.city,c.state,c.created_at,
             COUNT(DISTINCT au.building_id)::int buildings,
             COUNT(DISTINCT au.unit_id)::int units,
             COUNT(DISTINCT s.id)::int sensors
        FROM allowed_units au
        JOIN condominiums c ON c.id=au.condominium_id
        LEFT JOIN sensors s ON s.unit_id=au.unit_id
       GROUP BY c.id ORDER BY c.name`, [req.auth!.role==='superadmin',req.auth!.sub]);
    res.json(q.rows);
  });

  app.get('/api/v1/blocos', requireAuth, async (req: AuthenticatedRequest, res) => {
    const condo = typeof req.query.condominium_id==='string' && uuid.safeParse(req.query.condominium_id).success ? req.query.condominium_id : null;
    const q = await pool.query(`WITH allowed_units AS(${allowedUnitsSql})
      SELECT b.id,b.name,b.condominium_id,c.name condominium_name,
             COUNT(DISTINCT au.unit_id)::int units,COUNT(DISTINCT s.id)::int sensors
        FROM allowed_units au
        JOIN buildings b ON b.id=au.building_id JOIN condominiums c ON c.id=au.condominium_id
        LEFT JOIN sensors s ON s.unit_id=au.unit_id
       WHERE ($3::uuid IS NULL OR c.id=$3)
       GROUP BY b.id,c.name ORDER BY c.name,b.name`, [req.auth!.role==='superadmin',req.auth!.sub,condo]);
    res.json(q.rows);
  });

  app.get('/api/v1/unidades', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH allowed_units AS(${allowedUnitsSql})
      SELECT au.unit_id id,au.unit_identifier identifier,u.resident_name,au.building_id,au.building_name,
             au.condominium_id,au.condominium_name,s.id sensor_id,s.serial sensor_serial,
             COALESCE((SELECT SUM(tr.consumption_m3) FROM telemetry_readings tr WHERE tr.sensor_id=s.id AND tr.received_at>=date_trunc('month',now())),0)::float8 month_consumption_m3
        FROM allowed_units au JOIN units u ON u.id=au.unit_id LEFT JOIN sensors s ON s.unit_id=au.unit_id
       ORDER BY au.condominium_name,au.building_name,au.unit_identifier,s.serial`, [req.auth!.role==='superadmin',req.auth!.sub]);
    res.json(q.rows);
  });

  app.get('/api/v1/sensores', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH allowed_units AS(${allowedUnitsSql}),ss AS(${sensorScopeSql})
      SELECT sensor_id id,serial,sensor_type,central_serial,conversion_factor::float8,active,last_raw_value,last_reading_at,virtual_counter::float8,
             unit_id,unit_identifier,building_name,condominium_name,
             CASE WHEN last_reading_at>=now()-interval '10 minutes' THEN 'online' WHEN last_reading_at>=now()-interval '30 minutes' THEN 'attention' ELSE 'offline' END connection_status
        FROM ss ORDER BY last_reading_at DESC NULLS LAST,serial`, [req.auth!.role==='superadmin',req.auth!.sub]);
    res.json(q.rows);
  });

  app.get('/api/v1/telemetria/historico', requireAuth, async (req: AuthenticatedRequest, res) => {
    const sensor = typeof req.query.sensor_id==='string' ? req.query.sensor_id : '';
    if (!uuid.safeParse(sensor).success) return res.status(400).json({ error: 'sensor_id inválido' });
    const allowed = await pool.query(`WITH allowed_units AS(${allowedUnitsSql}),ss AS(${sensorScopeSql}) SELECT 1 FROM ss WHERE sensor_id=$3`, [req.auth!.role==='superadmin',req.auth!.sub,sensor]);
    if (!allowed.rowCount) return res.status(403).json({ error: 'Sem acesso a este sensor' });
    const limit = Math.min(1000,Math.max(1,Number(req.query.limit??200)||200));
    const q = await pool.query('SELECT id,raw_value,delta_raw,consumption_m3::float8,virtual_counter::float8,received_at,source_timestamp,status,offline_seconds FROM telemetry_readings WHERE sensor_id=$1 ORDER BY received_at DESC LIMIT $2',[sensor,limit]);
    res.json(q.rows);
  });
}
