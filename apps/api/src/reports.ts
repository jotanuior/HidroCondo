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

const grouping = {
  hour: { key: `to_char(date_trunc('hour',t.received_at),'YYYY-MM-DD HH24:00')`, label: `to_char(date_trunc('hour',t.received_at),'DD/MM/YYYY HH24:00')` },
  day: { key: `to_char(date_trunc('day',t.received_at),'YYYY-MM-DD')`, label: `to_char(date_trunc('day',t.received_at),'DD/MM/YYYY')` },
  week: { key: `to_char(date_trunc('week',t.received_at),'YYYY-MM-DD')`, label: `'Semana de '||to_char(date_trunc('week',t.received_at),'DD/MM/YYYY')` },
  month: { key: `to_char(date_trunc('month',t.received_at),'YYYY-MM')`, label: `to_char(date_trunc('month',t.received_at),'MM/YYYY')` },
  sensor: { key: `sc.sensor_id::text`, label: `sc.serial` },
  unit: { key: `sc.unit_id::text`, label: `sc.condominium_name||' · '||sc.building_name||' · '||sc.unit_identifier` },
  building: { key: `sc.building_id::text`, label: `sc.condominium_name||' · '||sc.building_name` },
  condominium: { key: `sc.condominium_id::text`, label: `sc.condominium_name` }
} as const;

export function registerReportRoutes(app: Express) {
  app.post('/api/v1/relatorios/consumo', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Filtros do relatório inválidos' });
    let range: { from: Date; to: Date };
    try { range = resolveRange(parsed.data.from, parsed.data.to); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Período inválido' }); }
    const p = parsed.data;
    const isSuper = req.auth!.role === 'superadmin';
    const params = [isSuper, req.auth!.sub, p.condominium_ids, p.building_ids, p.unit_ids, p.sensor_ids, range.from, range.to];
    const scopeSql = `
      SELECT s.id sensor_id,s.serial,u.id unit_id,u.identifier unit_identifier,
             b.id building_id,b.name building_name,c.id condominium_id,c.name condominium_name
        FROM sensors s
        JOIN units u ON u.id=s.unit_id
        JOIN buildings b ON b.id=u.building_id
        JOIN condominiums c ON c.id=b.condominium_id
       WHERE s.active=true
         AND ($1::boolean
              OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
              OR c.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
              OR u.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit'))
         AND (cardinality($3::uuid[])=0 OR c.id=ANY($3::uuid[]))
         AND (cardinality($4::uuid[])=0 OR b.id=ANY($4::uuid[]))
         AND (cardinality($5::uuid[])=0 OR u.id=ANY($5::uuid[]))
         AND (cardinality($6::uuid[])=0 OR s.id=ANY($6::uuid[]))`;

    const g = grouping[p.group_by];
    const grouped = await pool.query(`WITH scope AS(${scopeSql})
      SELECT ${g.key} group_key,${g.label} label,
             COALESCE(SUM(t.consumption_m3),0)::float8 consumption_m3,
             COUNT(*)::int readings,
             COUNT(DISTINCT sc.sensor_id)::int sensors
        FROM telemetry_readings t JOIN scope sc ON sc.sensor_id=t.sensor_id
       WHERE t.received_at >= $7 AND t.received_at < $8
       GROUP BY 1,2 ORDER BY 1`, params);

    const summary = await pool.query(`WITH scope AS(${scopeSql})
      SELECT COUNT(t.id)::int readings,
             COUNT(DISTINCT sc.sensor_id)::int sensors,
             COUNT(DISTINCT sc.unit_id)::int units,
             COUNT(DISTINCT sc.building_id)::int buildings,
             COUNT(DISTINCT sc.condominium_id)::int condominiums,
             COALESCE(SUM(t.consumption_m3),0)::float8 consumption_m3,
             COALESCE(SUM(CASE WHEN t.delta_raw=0 THEN 1 ELSE 0 END),0)::int zero_consumption_readings,
             COALESCE(SUM(CASE WHEN t.status LIKE '%recovered_after_offline%' THEN 1 ELSE 0 END),0)::int recoveries
        FROM scope sc LEFT JOIN telemetry_readings t ON t.sensor_id=sc.sensor_id AND t.received_at >= $7 AND t.received_at < $8`, params);

    const detail = await pool.query(`WITH scope AS(${scopeSql})
      SELECT t.id,t.received_at,t.source_timestamp,sc.condominium_id,sc.condominium_name,
             sc.building_id,sc.building_name,sc.unit_id,sc.unit_identifier,sc.sensor_id,sc.serial,
             t.raw_value,t.delta_raw,t.consumption_m3::float8,t.virtual_counter::float8,t.status,t.offline_seconds
        FROM telemetry_readings t JOIN scope sc ON sc.sensor_id=t.sensor_id
       WHERE t.received_at >= $7 AND t.received_at < $8
       ORDER BY t.received_at DESC LIMIT 10000`, params);

    const gapThreshold = p.gap_minutes * 60;
    const gaps = await pool.query(`WITH scope AS(${scopeSql}), r AS(
      SELECT sc.*,t.received_at,
             lag(t.received_at) OVER(PARTITION BY sc.sensor_id ORDER BY t.received_at) previous_at
        FROM scope sc JOIN telemetry_readings t ON t.sensor_id=sc.sensor_id
       WHERE t.received_at >= $7 AND t.received_at < $8
    )
    SELECT sensor_id,serial,condominium_name,building_name,unit_identifier,
           previous_at gap_start,received_at gap_end,
           EXTRACT(EPOCH FROM(received_at-previous_at))::bigint duration_seconds
      FROM r
     WHERE previous_at IS NOT NULL AND EXTRACT(EPOCH FROM(received_at-previous_at)) >= $9
     ORDER BY gap_start`, [...params, gapThreshold]);

    res.json({
      filters: { ...p, from: range.from.toISOString(), to_exclusive: range.to.toISOString() },
      summary: summary.rows[0],
      groups: grouped.rows,
      communication_gaps: gaps.rows,
      detail: detail.rows,
      detail_truncated: detail.rowCount === 10000
    });
  });

  app.post('/api/v1/relatorios/consumo.csv', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Filtros do relatório inválidos' });
    let range: { from: Date; to: Date };
    try { range = resolveRange(parsed.data.from, parsed.data.to); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Período inválido' }); }
    const p = parsed.data;
    const isSuper = req.auth!.role === 'superadmin';
    const q = await pool.query(`
      SELECT t.received_at,c.name condominium,b.name building,u.identifier unit,s.serial sensor,
             t.raw_value,t.delta_raw,t.consumption_m3::float8,t.virtual_counter::float8,t.status
        FROM telemetry_readings t
        JOIN sensors s ON s.id=t.sensor_id JOIN units u ON u.id=s.unit_id
        JOIN buildings b ON b.id=u.building_id JOIN condominiums c ON c.id=b.condominium_id
       WHERE t.received_at >= $7 AND t.received_at < $8
         AND ($1::boolean OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
              OR c.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='condominium')
              OR u.id IN(SELECT scope_id FROM access_grants WHERE user_id=$2 AND scope_type='unit'))
         AND (cardinality($3::uuid[])=0 OR c.id=ANY($3::uuid[]))
         AND (cardinality($4::uuid[])=0 OR b.id=ANY($4::uuid[]))
         AND (cardinality($5::uuid[])=0 OR u.id=ANY($5::uuid[]))
         AND (cardinality($6::uuid[])=0 OR s.id=ANY($6::uuid[]))
       ORDER BY t.received_at`, [isSuper,req.auth!.sub,p.condominium_ids,p.building_ids,p.unit_ids,p.sensor_ids,range.from,range.to]);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const lines = ['Data;Condomínio;Bloco;Unidade;Sensor;Leitura;Delta;Consumo m3;Leitura hidrômetro m3;Status'];
    for (const r of q.rows) lines.push([new Date(r.received_at).toISOString(),r.condominium,r.building,r.unit,r.sensor,r.raw_value,r.delta_raw,r.consumption_m3,r.virtual_counter,r.status].map(esc).join(';'));
    res.setHeader('content-type','text/csv; charset=utf-8');
    res.setHeader('content-disposition',`attachment; filename="hidrocondo-consumo-${parsed.data.from}-${parsed.data.to}.csv"`);
    res.send('\uFEFF'+lines.join('\n'));
  });
}
