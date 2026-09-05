import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid = z.string().uuid();
const reportSchema = z.object({
  from: z.string().min(8),
  to: z.string().min(8),
  condominium_ids: z.array(uuid).default([]),
  building_ids: z.array(uuid).default([]),
  unit_ids: z.array(uuid).default([]),
  sensor_ids: z.array(uuid).default([]),
  group_by: z.enum(['hour','day','week','month','sensor','unit','building','condominium']).default('day'),
  gap_minutes: z.coerce.number().int().min(1).max(1440).default(30)
});

function resolveRange(fromRaw: string, toRaw: string) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const from = dateOnly.test(fromRaw) ? new Date(`${fromRaw}T00:00:00-03:00`) : new Date(fromRaw);
  const to = dateOnly.test(toRaw) ? new Date(`${toRaw}T00:00:00-03:00`) : new Date(toRaw);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Período inválido');
  if (dateOnly.test(toRaw)) to.setDate(to.getDate() + 1);
  if (to <= from) throw new Error('A data final deve ser posterior à inicial');
  if (to.getTime() - from.getTime() > 370 * 86400_000) throw new Error('O período máximo por relatório é de 370 dias');
  return { from, to };
}

const accessibleSensorsSql = `
  SELECT DISTINCT s.id sensor_id,s.serial,s.unit_id current_unit_id,s.account_id
    FROM sensors s
    LEFT JOIN units cu ON cu.id=s.unit_id
    LEFT JOIN buildings cb ON cb.id=cu.building_id
    LEFT JOIN condominiums cc ON cc.id=cb.condominium_id
   WHERE s.active=true AND (
         $1::boolean
      OR s.account_id IN(SELECT account_id FROM account_members WHERE user_id=$2)
      OR s.account_id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='account')
      OR cc.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
      OR cc.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
      OR cb.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='building')
      OR cu.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit')
      OR s.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='sensor')
   )`;

const eventsSql = `
  SELECT t.id,t.received_at,t.source_timestamp,t.raw_value,t.delta_raw,t.consumption_m3,t.virtual_counter,t.status,t.offline_seconds,
         s.sensor_id,s.serial,
         u.id unit_id,u.identifier unit_identifier,b.id building_id,b.name building_name,c.id condominium_id,c.name condominium_name
    FROM telemetry_readings t
    JOIN accessible_sensors s ON s.sensor_id=t.sensor_id
    LEFT JOIN LATERAL (
      SELECT si.unit_id
        FROM sensor_installations si
       WHERE si.sensor_id=s.sensor_id
         AND t.received_at>=si.installed_at
         AND (si.removed_at IS NULL OR t.received_at<si.removed_at)
       ORDER BY si.installed_at DESC
       LIMIT 1
    ) hist ON true
    LEFT JOIN units u ON u.id=CASE
      WHEN hist.unit_id IS NOT NULL THEN hist.unit_id
      WHEN NOT EXISTS(SELECT 1 FROM sensor_installations sx WHERE sx.sensor_id=s.sensor_id) THEN s.current_unit_id
      ELSE NULL END
    LEFT JOIN buildings b ON b.id=u.building_id
    LEFT JOIN condominiums c ON c.id=b.condominium_id
   WHERE t.received_at >= $7 AND t.received_at < $8
     AND (cardinality($3::uuid[])=0 OR c.id=ANY($3::uuid[]))
     AND (cardinality($4::uuid[])=0 OR b.id=ANY($4::uuid[]))
     AND (cardinality($5::uuid[])=0 OR u.id=ANY($5::uuid[]))
     AND (cardinality($6::uuid[])=0 OR s.sensor_id=ANY($6::uuid[]))`;

const grouping = {
  hour: { key: `to_char(date_trunc('hour',e.received_at),'YYYY-MM-DD HH24:00')`, label: `to_char(date_trunc('hour',e.received_at),'DD/MM/YYYY HH24:00')` },
  day: { key: `to_char(date_trunc('day',e.received_at),'YYYY-MM-DD')`, label: `to_char(date_trunc('day',e.received_at),'DD/MM/YYYY')` },
  week: { key: `to_char(date_trunc('week',e.received_at),'YYYY-MM-DD')`, label: `'Semana de '||to_char(date_trunc('week',e.received_at),'DD/MM/YYYY')` },
  month: { key: `to_char(date_trunc('month',e.received_at),'YYYY-MM')`, label: `to_char(date_trunc('month',e.received_at),'MM/YYYY')` },
  sensor: { key: `e.sensor_id::text`, label: `e.serial` },
  unit: { key: `COALESCE(e.unit_id::text,'unassigned')`, label: `COALESCE(e.condominium_name||' · '||e.building_name||' · '||e.unit_identifier,'Sem vínculo')` },
  building: { key: `COALESCE(e.building_id::text,'unassigned')`, label: `COALESCE(e.condominium_name||' · '||e.building_name,'Sem vínculo')` },
  condominium: { key: `COALESCE(e.condominium_id::text,'unassigned')`, label: `COALESCE(e.condominium_name,'Sem vínculo')` }
} as const;

function paramsFor(req: AuthenticatedRequest, p: z.infer<typeof reportSchema>, range: {from:Date;to:Date}) {
  return [req.auth!.role==='superadmin',req.auth!.sub,p.condominium_ids,p.building_ids,p.unit_ids,p.sensor_ids,range.from,range.to];
}

export function registerReportRoutes(app: Express) {
  app.post('/api/v1/relatorios/consumo', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Filtros do relatório inválidos' });
    let range: { from: Date; to: Date };
    try { range = resolveRange(parsed.data.from, parsed.data.to); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Período inválido' }); }
    const p = parsed.data, params = paramsFor(req,p,range), g = grouping[p.group_by];

    const grouped = await pool.query(`WITH accessible_sensors AS(${accessibleSensorsSql}),events AS(${eventsSql})
      SELECT ${g.key} group_key,${g.label} label,
             COALESCE(SUM(e.consumption_m3),0)::float8 consumption_m3,
             COUNT(*)::int readings,COUNT(DISTINCT e.sensor_id)::int sensors
        FROM events e GROUP BY 1,2 ORDER BY 1`, params);

    const summary = await pool.query(`WITH accessible_sensors AS(${accessibleSensorsSql}),events AS(${eventsSql})
      SELECT COUNT(*)::int readings,COUNT(DISTINCT sensor_id)::int sensors,
             COUNT(DISTINCT unit_id)::int units,COUNT(DISTINCT building_id)::int buildings,
             COUNT(DISTINCT condominium_id)::int condominiums,
             COALESCE(SUM(consumption_m3),0)::float8 consumption_m3,
             COALESCE(SUM(CASE WHEN delta_raw=0 THEN 1 ELSE 0 END),0)::int zero_consumption_readings,
             COALESCE(SUM(CASE WHEN status LIKE '%recovered_after_offline%' THEN 1 ELSE 0 END),0)::int recoveries
        FROM events`, params);

    const detail = await pool.query(`WITH accessible_sensors AS(${accessibleSensorsSql}),events AS(${eventsSql})
      SELECT id,received_at,source_timestamp,condominium_id,condominium_name,building_id,building_name,
             unit_id,unit_identifier,sensor_id,serial,raw_value,delta_raw,consumption_m3::float8,
             virtual_counter::float8,status,offline_seconds
        FROM events ORDER BY received_at DESC LIMIT 10000`, params);

    const gapThreshold = p.gap_minutes * 60;
    const gaps = await pool.query(`WITH accessible_sensors AS(${accessibleSensorsSql}),events AS(${eventsSql}),r AS(
      SELECT e.*,lag(e.received_at) OVER(PARTITION BY e.sensor_id ORDER BY e.received_at) previous_at
        FROM events e
    )
    SELECT sensor_id,serial,condominium_name,building_name,unit_identifier,
           previous_at gap_start,received_at gap_end,
           EXTRACT(EPOCH FROM(received_at-previous_at))::bigint duration_seconds
      FROM r WHERE previous_at IS NOT NULL AND EXTRACT(EPOCH FROM(received_at-previous_at)) >= $9
      ORDER BY gap_start`, [...params,gapThreshold]);

    res.json({
      filters:{...p,from:range.from.toISOString(),to_exclusive:range.to.toISOString()},
      summary:summary.rows[0],groups:grouped.rows,communication_gaps:gaps.rows,
      detail:detail.rows,detail_truncated:detail.rowCount===10000
    });
  });

  app.post('/api/v1/relatorios/consumo.csv', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Filtros do relatório inválidos' });
    let range: { from: Date; to: Date };
    try { range = resolveRange(parsed.data.from, parsed.data.to); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Período inválido' }); }
    const p=parsed.data,params=paramsFor(req,p,range);
    const q=await pool.query(`WITH accessible_sensors AS(${accessibleSensorsSql}),events AS(${eventsSql})
      SELECT received_at,condominium_name condominium,building_name building,unit_identifier unit,serial sensor,
             raw_value,delta_raw,consumption_m3::float8,virtual_counter::float8,status
        FROM events ORDER BY received_at`,params);
    const esc=(v:unknown)=>`"${String(v??'').replace(/"/g,'""')}"`;
    const lines=['Data;Condomínio;Bloco;Unidade;Sensor;Leitura;Delta;Consumo m3;Leitura hidrômetro m3;Status'];
    for(const r of q.rows) lines.push([new Date(r.received_at).toISOString(),r.condominium,r.building,r.unit,r.sensor,r.raw_value,r.delta_raw,r.consumption_m3,r.virtual_counter,r.status].map(esc).join(';'));
    res.setHeader('content-type','text/csv; charset=utf-8');
    res.setHeader('content-disposition',`attachment; filename="hidrocondo-consumo-${p.from}-${p.to}.csv"`);
    res.send('\uFEFF'+lines.join('\n'));
  });
}
