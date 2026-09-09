import { pool } from './db.js';
import { operationalSensors } from './operation-scope.js';

// Malformed legacy rules are ignored, rather than crashing the evaluator.
const validRules = `SELECT a.*,
  CASE WHEN config->>'minutes' ~ '^[0-9]{1,5}$' THEN (config->>'minutes')::int END offline_minutes,
  CASE WHEN config->>'threshold_m3' ~ '^[0-9]{1,9}(\\.[0-9]{1,9})?$' THEN (config->>'threshold_m3')::numeric END threshold_m3,
  CASE WHEN NOT(config ? 'window_minutes') THEN 1440
    WHEN config->>'window_minutes' ~ '^[0-9]{1,5}$' THEN (config->>'window_minutes')::int END window_minutes
  FROM alert_rules a WHERE enabled`;

export async function evaluateAlerts() {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const lock=await client.query('SELECT pg_try_advisory_xact_lock(73421,7) locked');
    if (!lock.rows[0].locked) { await client.query('ROLLBACK');return; }
    await client.query(`CREATE TEMP TABLE hidro_alert_candidates ON COMMIT DROP AS
      WITH sensors_scope AS(${operationalSensors}), rules AS(${validRules})
      SELECT s.*,r.id rule_id,r.id::text rule_key,
        concat_ws(':',s.account_id,s.condominium_id,s.building_id,s.unit_id) scope_key,
        r.type kind,
        CASE WHEN r.type='offline' THEN 'Sensor sem comunicação' ELSE 'Consumo acima do limite' END title,
        CASE WHEN r.type='offline' THEN jsonb_build_object('minutes',r.offline_minutes,'last_seen_at',s.last_seen_at)
          ELSE jsonb_build_object('threshold_m3',r.threshold_m3,'window_minutes',r.window_minutes,'consumption_m3',v.volume) END details
      FROM sensors_scope s JOIN rules r ON r.condominium_id=s.condominium_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(t.consumption_m3),0) volume FROM telemetry_readings t
        WHERE r.type='consumption' AND t.sensor_id=s.sensor_id
          AND t.received_at >= now()-make_interval(mins=>r.window_minutes)
          AND t.received_at <= now()
          AND (NOT EXISTS(SELECT 1 FROM sensor_installations si WHERE si.sensor_id=s.sensor_id)
            OR EXISTS(SELECT 1 FROM sensor_installations si WHERE si.sensor_id=s.sensor_id AND si.unit_id=s.unit_id
              AND t.received_at>=si.installed_at AND (si.removed_at IS NULL OR t.received_at<si.removed_at)))
      ) v ON true
      WHERE s.active AND (
        (r.type='offline' AND r.offline_minutes BETWEEN 1 AND 10080
          AND COALESCE(s.last_seen_at,s.claimed_at,s.created_at)<now()-make_interval(mins=>r.offline_minutes))
        OR (r.type='consumption' AND r.window_minutes BETWEEN 1 AND 10080 AND r.threshold_m3>0 AND v.volume>r.threshold_m3))
      UNION ALL
      SELECT s.*,NULL::uuid,'measurement_review',concat_ws(':',s.account_id,s.condominium_id,s.building_id,s.unit_id),
        'measurement_review','Leitura precisa de conferência',jsonb_build_object('last_reading_at',s.last_reading_at)
      FROM sensors_scope s WHERE s.active AND s.needs_review`);
    // Resolved-by-user incidents stay quiet while the same condition persists.
    const inserted=await client.query(`INSERT INTO alert_occurrences(sensor_id,rule_id,rule_key,scope_key,account_id,
      condominium_id,building_id,unit_id,serial,condominium_name,building_name,unit_identifier,kind,title,details)
      SELECT sensor_id,rule_id,rule_key,scope_key,account_id,condominium_id,building_id,unit_id,serial,
        condominium_name,building_name,unit_identifier,kind,title,details FROM hidro_alert_candidates
      ON CONFLICT(sensor_id,kind,rule_key,scope_key) WHERE condition_active DO NOTHING RETURNING id`);
    for (const row of inserted.rows) await client.query(`INSERT INTO alert_occurrence_events(occurrence_id,action,note)
      VALUES($1,'opened','Condição detectada automaticamente')`,[row.id]);
    await client.query(`UPDATE alert_occurrences o SET last_detected_at=now(),details=c.details
      FROM hidro_alert_candidates c WHERE o.condition_active AND o.sensor_id=c.sensor_id
        AND o.kind=c.kind AND o.rule_key=c.rule_key AND o.scope_key=c.scope_key`);
    const cleared=await client.query(`UPDATE alert_occurrences o SET condition_active=false,
      status='resolved',resolved_at=COALESCE(resolved_at,now()),
      resolution_note=COALESCE(resolution_note,'Condição encerrada: recuperação, desativação, mudança de instalação ou regra')
      WHERE condition_active AND NOT EXISTS(SELECT 1 FROM hidro_alert_candidates c WHERE c.sensor_id=o.sensor_id
        AND c.kind=o.kind AND c.rule_key=o.rule_key AND c.scope_key=o.scope_key) RETURNING id`);
    for (const row of cleared.rows) await client.query(`INSERT INTO alert_occurrence_events(occurrence_id,action,note)
      VALUES($1,'condition_cleared','Condição deixou de ser detectada')`,[row.id]);
    await client.query(`INSERT INTO alert_evaluation_state(id,last_success_at) VALUES(1,now())
      ON CONFLICT(id) DO UPDATE SET last_success_at=excluded.last_success_at`);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
}

export function startAlertWorker() {
  let running=false;
  const tick=async()=>{
    if(running)return;
    running=true;
    try { await evaluateAlerts(); } catch(error) { console.error('[alertas] Falha ao avaliar ocorrências',error); }
    finally { running=false; }
  };
  void tick();
  const timer=setInterval(()=>void tick(),60_000);timer.unref();
  return ()=>clearInterval(timer);
}
