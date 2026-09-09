import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';
import { operationalSensors, scopePermission } from './operation-scope.js';

const timeZone="'America/Sao_Paulo'";
const base=`WITH scope AS(${operationalSensors}), ss AS(
  SELECT * FROM scope o WHERE ${scopePermission('o')} AND ($4::uuid IS NULL OR condominium_id=$4)
), clock AS(SELECT now() AT TIME ZONE ${timeZone} local_now), bounds AS(
  SELECT local_now,date_trunc('day',local_now) day_start,date_trunc('month',local_now) month_start,
    date_trunc('month',local_now)-interval '1 month' previous_start,
    least(date_trunc('month',local_now),date_trunc('month',local_now)-interval '1 month'
      +(local_now-date_trunc('month',local_now))) previous_end FROM clock
), raw_events AS(
  SELECT t.*,COALESCE(c.account_id,s.account_id) account_id,
    u.id unit_id,b.id building_id,c.id condominium_id
  FROM telemetry_readings t JOIN ss s ON s.sensor_id=t.sensor_id
  LEFT JOIN LATERAL(SELECT si.unit_id FROM sensor_installations si WHERE si.sensor_id=s.sensor_id
    AND t.received_at>=si.installed_at AND (si.removed_at IS NULL OR t.received_at<si.removed_at)
    ORDER BY si.installed_at DESC LIMIT 1) history ON true
  LEFT JOIN units u ON u.id=CASE WHEN history.unit_id IS NOT NULL THEN history.unit_id
    WHEN NOT EXISTS(SELECT 1 FROM sensor_installations si WHERE si.sensor_id=s.sensor_id) THEN s.unit_id ELSE NULL END
  LEFT JOIN buildings b ON b.id=u.building_id LEFT JOIN condominiums c ON c.id=b.condominium_id
  WHERE t.received_at>=(SELECT least(previous_start,day_start-interval '13 days') AT TIME ZONE ${timeZone} FROM bounds)
    AND t.received_at<=now()
), events AS(SELECT * FROM raw_events o WHERE ${scopePermission('o')}
  AND ($4::uuid IS NULL OR condominium_id=$4))`;

export function registerOperationalDashboard(app: Express) {
  app.get('/api/v1/dashboard/operacional',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const p=z.object({condominium_id:z.string().uuid().optional()}).safeParse(req.query);
    if(!p.success)return res.status(400).json({error:'Condomínio inválido'});
    const params=[req.auth!.role==='superadmin',req.auth!.sub,null,p.data.condominium_id??null];
    // One snapshot keeps cards, charts and attention lists consistent during ingestion.
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const summary=await client.query(`${base} SELECT
        (SELECT COUNT(*) FROM ss WHERE active)::int sensors,
        (SELECT COUNT(*) FROM ss WHERE active AND last_seen_at>=now()-interval '10 minutes')::int online,
        (SELECT COUNT(*) FROM ss WHERE active AND last_seen_at<now()-interval '10 minutes' AND last_seen_at>=now()-interval '30 minutes')::int attention,
        (SELECT COUNT(*) FROM ss WHERE active AND last_seen_at<now()-interval '30 minutes')::int offline,
        (SELECT COUNT(*) FROM ss WHERE active AND last_seen_at IS NULL)::int never_seen,
        (SELECT COUNT(*) FROM ss WHERE active AND needs_review)::int needs_review,
        (SELECT COUNT(DISTINCT unit_id) FROM ss)::int units,
        COALESCE(SUM(consumption_m3) FILTER(WHERE received_at>=b.day_start AT TIME ZONE ${timeZone}),0)::float8 today_m3,
        COALESCE(SUM(consumption_m3) FILTER(WHERE received_at>=b.month_start AT TIME ZONE ${timeZone}),0)::float8 month_m3,
        COALESCE(SUM(consumption_m3) FILTER(WHERE received_at>=b.previous_start AT TIME ZONE ${timeZone}
          AND received_at<b.previous_end AT TIME ZONE ${timeZone}),0)::float8 previous_m3,
        COUNT(*) FILTER(WHERE received_at>=b.previous_start AT TIME ZONE ${timeZone}
          AND received_at<b.previous_end AT TIME ZONE ${timeZone})::int previous_readings
        FROM bounds b LEFT JOIN events ON true`,params);
      const series=await client.query(`${base}, days AS(
        SELECT generate_series(day_start-interval '13 days',day_start,interval '1 day') AS day FROM bounds)
        SELECT to_char(d.day,'YYYY-MM-DD') AS day,COALESCE(SUM(e.consumption_m3),0)::float8 consumption_m3,COUNT(e.id)::int readings
        FROM days d LEFT JOIN events e ON e.received_at>=d.day AT TIME ZONE ${timeZone}
          AND e.received_at<(d.day+interval '1 day') AT TIME ZONE ${timeZone}
        GROUP BY d.day ORDER BY d.day`,params);
      const attention=await client.query(`${base} SELECT sensor_id,serial,condominium_name,unit_identifier,last_seen_at,needs_review,
        CASE WHEN last_seen_at IS NULL THEN 'never' WHEN last_seen_at<now()-interval '30 minutes' THEN 'offline'
          WHEN last_seen_at<now()-interval '10 minutes' THEN 'attention' ELSE 'online' END connection_status
        FROM ss WHERE active AND (needs_review OR last_seen_at IS NULL OR last_seen_at<now()-interval '10 minutes')
        ORDER BY needs_review DESC,last_seen_at NULLS FIRST,serial LIMIT 12`,params);
      const units=await client.query(`${base} SELECT s.unit_id,s.unit_identifier,s.building_name,s.condominium_name,
        COUNT(*)::int sensors,BOOL_OR(s.needs_review) needs_review,
        COALESCE((SELECT SUM(e.consumption_m3) FROM events e WHERE e.unit_id=s.unit_id
          AND e.received_at>=(SELECT month_start AT TIME ZONE ${timeZone} FROM bounds)),0)::float8 month_m3
        FROM ss s WHERE s.unit_id IS NOT NULL GROUP BY s.unit_id,s.unit_identifier,s.building_name,s.condominium_name
        ORDER BY s.condominium_name,s.building_name,s.unit_identifier LIMIT 24`,params);
      const incidents=await client.query(`SELECT COUNT(*) FILTER(WHERE o.status='open')::int open,
        COUNT(*) FILTER(WHERE o.status='acknowledged')::int acknowledged
        FROM alert_occurrences o WHERE ${scopePermission('o')} AND ($4::uuid IS NULL OR condominium_id=$4)`,params);
      await client.query('COMMIT');
      const s=summary.rows[0];
      res.json({profile:req.auth!.role==='morador'?'resident':['superadmin','admin'].includes(req.auth!.role)?'management':'operations',
        summary:{...s,...incidents.rows[0],change_percent:s.previous_readings>0&&s.previous_m3>0?(s.month_m3-s.previous_m3)/s.previous_m3*100:null},
        series:series.rows,attention:attention.rows,units:units.rows,updated_at:new Date().toISOString(),timezone:'America/Sao_Paulo'});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
}
