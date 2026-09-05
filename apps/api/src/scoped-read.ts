import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid = z.string().uuid();

const accessibleCondosSql = `
  SELECT DISTINCT c.id,c.name,c.document,c.city,c.state,c.account_id,c.created_at
    FROM condominiums c
   WHERE $1::boolean
      OR c.account_id IN(SELECT account_id FROM account_members WHERE user_id=$2)
      OR c.account_id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='account')
      OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
      OR c.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
      OR c.id IN(SELECT b.condominium_id FROM buildings b WHERE b.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='building'))
      OR c.id IN(SELECT b.condominium_id FROM units u JOIN buildings b ON b.id=u.building_id WHERE u.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit'))
      OR c.id IN(SELECT b.condominium_id FROM sensors s JOIN units u ON u.id=s.unit_id JOIN buildings b ON b.id=u.building_id WHERE s.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='sensor'))`;

const accessibleBuildingsSql = `
  SELECT DISTINCT b.id,b.name,b.condominium_id,c.name condominium_name,c.account_id
    FROM buildings b
    JOIN condominiums c ON c.id=b.condominium_id
   WHERE $1::boolean
      OR c.account_id IN(SELECT account_id FROM account_members WHERE user_id=$2)
      OR c.account_id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='account')
      OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
      OR c.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
      OR b.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='building')
      OR b.id IN(SELECT u.building_id FROM units u WHERE u.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit'))
      OR b.id IN(SELECT u.building_id FROM sensors s JOIN units u ON u.id=s.unit_id WHERE s.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='sensor'))`;

const accessibleUnitsSql = `
  SELECT DISTINCT u.id unit_id,u.identifier unit_identifier,u.resident_name,
         b.id building_id,b.name building_name,c.id condominium_id,c.name condominium_name,c.account_id
    FROM units u
    JOIN buildings b ON b.id=u.building_id
    JOIN condominiums c ON c.id=b.condominium_id
   WHERE $1::boolean
      OR c.account_id IN(SELECT account_id FROM account_members WHERE user_id=$2)
      OR c.account_id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='account')
      OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
      OR c.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
      OR b.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='building')
      OR u.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit')
      OR u.id IN(SELECT s.unit_id FROM sensors s WHERE s.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='sensor') AND s.unit_id IS NOT NULL)`;

const accessibleSensorsSql = `
  SELECT DISTINCT s.id sensor_id,s.serial,s.sensor_type,s.central_serial,s.conversion_factor,s.active,
         s.last_raw_value,s.last_reading_at,s.virtual_counter,s.unit_id,s.account_id,s.claimed_at,
         u.identifier unit_identifier,b.id building_id,b.name building_name,c.id condominium_id,c.name condominium_name
    FROM sensors s
    LEFT JOIN units u ON u.id=s.unit_id
    LEFT JOIN buildings b ON b.id=u.building_id
    LEFT JOIN condominiums c ON c.id=b.condominium_id
   WHERE $1::boolean
      OR s.account_id IN(SELECT account_id FROM account_members WHERE user_id=$2)
      OR s.account_id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='account')
      OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
      OR c.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
      OR b.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='building')
      OR u.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit')
      OR s.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='sensor')`;

export function registerScopedReadRoutes(app: Express) {
  app.get('/api/v1/dashboard/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH ac AS(${accessibleCondosSql}),au AS(${accessibleUnitsSql}),ss AS(${accessibleSensorsSql})
      SELECT (SELECT COUNT(*) FROM ac)::int condominiums,
             (SELECT COUNT(*) FROM au)::int units,
             (SELECT COUNT(*) FROM ss)::int sensors,
             (SELECT COUNT(*) FROM ss WHERE last_reading_at>=now()-interval '10 minutes')::int sensors_online,
             (SELECT COUNT(*) FROM ss WHERE last_reading_at<now()-interval '30 minutes' OR last_reading_at IS NULL)::int sensors_offline,
             COALESCE((SELECT SUM(t.consumption_m3) FROM telemetry_readings t WHERE t.received_at>=date_trunc('month',now()) AND t.sensor_id IN(SELECT sensor_id FROM ss)),0)::float8 month_consumption_m3,
             COALESCE((SELECT SUM(t.consumption_m3) FROM telemetry_readings t WHERE t.received_at>=date_trunc('day',now()) AND t.sensor_id IN(SELECT sensor_id FROM ss)),0)::float8 today_consumption_m3`,
      [req.auth!.role==='superadmin', req.auth!.sub]);
    res.json(q.rows[0]);
  });

  app.get('/api/v1/dashboard/series', requireAuth, async (req: AuthenticatedRequest, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14) || 14));
    const q = await pool.query(`WITH ss AS(${accessibleSensorsSql}),dates AS(
      SELECT generate_series(current_date-($3::int-1),current_date,interval '1 day')::date AS day
    )
      SELECT to_char(d.day,'YYYY-MM-DD') AS day,COALESCE(SUM(t.consumption_m3),0)::float8 consumption_m3
        FROM dates d
        LEFT JOIN telemetry_readings t ON t.received_at>=d.day::timestamp AND t.received_at<(d.day+1)::timestamp
          AND t.sensor_id IN(SELECT sensor_id FROM ss)
       GROUP BY d.day ORDER BY d.day`,
      [req.auth!.role==='superadmin', req.auth!.sub, days]);
    res.json(q.rows);
  });

  app.get('/api/v1/condominios', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH ac AS(${accessibleCondosSql}),ab AS(${accessibleBuildingsSql}),au AS(${accessibleUnitsSql}),ss AS(${accessibleSensorsSql})
      SELECT ac.id,ac.name,ac.document,ac.city,ac.state,ac.account_id,ac.created_at,
             (SELECT COUNT(*) FROM ab WHERE condominium_id=ac.id)::int buildings,
             (SELECT COUNT(*) FROM au WHERE condominium_id=ac.id)::int units,
             (SELECT COUNT(*) FROM ss WHERE condominium_id=ac.id)::int sensors
        FROM ac ORDER BY ac.name`, [req.auth!.role==='superadmin',req.auth!.sub]);
    res.json(q.rows);
  });

  app.get('/api/v1/blocos', requireAuth, async (req: AuthenticatedRequest, res) => {
    const condo = typeof req.query.condominium_id==='string' && uuid.safeParse(req.query.condominium_id).success ? req.query.condominium_id : null;
    const q = await pool.query(`WITH ab AS(${accessibleBuildingsSql}),au AS(${accessibleUnitsSql}),ss AS(${accessibleSensorsSql})
      SELECT ab.id,ab.name,ab.condominium_id,ab.condominium_name,
             (SELECT COUNT(*) FROM au WHERE building_id=ab.id)::int units,
             (SELECT COUNT(*) FROM ss WHERE building_id=ab.id)::int sensors
        FROM ab WHERE ($3::uuid IS NULL OR ab.condominium_id=$3)
       ORDER BY ab.condominium_name,ab.name`, [req.auth!.role==='superadmin',req.auth!.sub,condo]);
    res.json(q.rows);
  });

  app.get('/api/v1/unidades', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH au AS(${accessibleUnitsSql}),ss AS(${accessibleSensorsSql})
      SELECT au.unit_id id,au.unit_identifier identifier,au.resident_name,au.building_id,au.building_name,
             au.condominium_id,au.condominium_name,
             (SELECT MIN(s.serial) FROM ss s WHERE s.unit_id=au.unit_id) sensor_serial,
             (SELECT COUNT(*) FROM ss s WHERE s.unit_id=au.unit_id)::int sensor_count,
             COALESCE((
               SELECT SUM(t.consumption_m3)
                 FROM telemetry_readings t
                 JOIN sensors sx ON sx.id=t.sensor_id
                WHERE sx.id IN(SELECT sensor_id FROM ss)
                  AND t.received_at>=date_trunc('month',now())
                  AND (
                    EXISTS(SELECT 1 FROM sensor_installations si
                            WHERE si.sensor_id=sx.id AND si.unit_id=au.unit_id
                              AND t.received_at>=si.installed_at
                              AND (si.removed_at IS NULL OR t.received_at<si.removed_at))
                    OR (
                      NOT EXISTS(SELECT 1 FROM sensor_installations si0 WHERE si0.sensor_id=sx.id)
                      AND sx.unit_id=au.unit_id
                    )
                  )
             ),0)::float8 month_consumption_m3
        FROM au ORDER BY au.condominium_name,au.building_name,au.unit_identifier`,
      [req.auth!.role==='superadmin',req.auth!.sub]);
    res.json(q.rows);
  });

  app.get('/api/v1/sensores', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`WITH ss AS(${accessibleSensorsSql})
      SELECT sensor_id id,serial,sensor_type,central_serial,conversion_factor::float8,active,last_raw_value,last_reading_at,virtual_counter::float8,
             unit_id,unit_identifier,building_id,building_name,condominium_id,condominium_name,account_id,claimed_at,
             CASE WHEN last_reading_at>=now()-interval '10 minutes' THEN 'online'
                  WHEN last_reading_at>=now()-interval '30 minutes' THEN 'attention'
                  ELSE 'offline' END connection_status
        FROM ss ORDER BY last_reading_at DESC NULLS LAST,serial`,
      [req.auth!.role==='superadmin',req.auth!.sub]);
    res.json(q.rows);
  });

  app.get('/api/v1/telemetria/historico', requireAuth, async (req: AuthenticatedRequest, res) => {
    const sensor = typeof req.query.sensor_id==='string' ? req.query.sensor_id : '';
    if (!uuid.safeParse(sensor).success) return res.status(400).json({ error: 'sensor_id inválido' });
    const allowed = await pool.query(`WITH ss AS(${accessibleSensorsSql}) SELECT 1 FROM ss WHERE sensor_id=$3`,
      [req.auth!.role==='superadmin',req.auth!.sub,sensor]);
    if (!allowed.rowCount) return res.status(403).json({ error: 'Sem acesso a este sensor' });
    const limit = Math.min(1000,Math.max(1,Number(req.query.limit??200)||200));
    const q = await pool.query(
      'SELECT id,raw_value,delta_raw,consumption_m3::float8,virtual_counter::float8,received_at,source_timestamp,status,offline_seconds FROM telemetry_readings WHERE sensor_id=$1 ORDER BY received_at DESC LIMIT $2',
      [sensor,limit]
    );
    res.json(q.rows);
  });
}
