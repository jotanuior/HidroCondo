import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, signToken, type AuthenticatedRequest } from './auth.js';
import { ingestTelemetry } from './telemetry.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'hidrocondo-api' });
  } catch {
    res.status(503).json({ ok: false, service: 'hidrocondo-api' });
  }
});

app.post('/api/v1/auth/login', async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados de login inválidos' });

  const result = await pool.query(
    `SELECT id, name, email, password_hash, role
       FROM users
      WHERE lower(email) = lower($1) AND active = true`,
    [parsed.data.email]
  );

  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  }

  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/v1/telemetria', async (req, res) => {
  const expected = process.env.TELEMETRY_API_KEY;
  const supplied = req.header('x-api-key');
  if (!expected || !supplied || supplied !== expected) {
    return res.status(401).json({ error: 'Chave de telemetria inválida' });
  }

  try {
    const result = await ingestTelemetry(req.body, req.header('x-event-id') ?? undefined);
    res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao processar telemetria';
    res.status(400).json({ ok: false, error: message });
  }
});

app.get('/api/v1/dashboard/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.auth!.sub;
  const isSuper = req.auth!.role === 'superadmin';

  const accessClause = isSuper
    ? 'TRUE'
    : `c.id IN (SELECT condominium_id FROM user_condominiums WHERE user_id = $1)`;

  const params = isSuper ? [] : [userId];

  const result = await pool.query(
    `WITH accessible_condos AS (
       SELECT c.id, c.name FROM condominiums c WHERE ${accessClause}
     ), sensor_scope AS (
       SELECT s.id, s.last_reading_at, u.id AS unit_id, b.condominium_id
         FROM sensors s
         LEFT JOIN units u ON u.id = s.unit_id
         LEFT JOIN buildings b ON b.id = u.building_id
        WHERE b.condominium_id IN (SELECT id FROM accessible_condos)
     ), month_usage AS (
       SELECT tr.sensor_id, COALESCE(SUM(tr.consumption_m3),0) AS consumption
         FROM telemetry_readings tr
        WHERE tr.received_at >= date_trunc('month', now())
          AND tr.sensor_id IN (SELECT id FROM sensor_scope)
        GROUP BY tr.sensor_id
     ), today_usage AS (
       SELECT tr.sensor_id, COALESCE(SUM(tr.consumption_m3),0) AS consumption
         FROM telemetry_readings tr
        WHERE tr.received_at >= date_trunc('day', now())
          AND tr.sensor_id IN (SELECT id FROM sensor_scope)
        GROUP BY tr.sensor_id
     )
     SELECT
       (SELECT COUNT(*) FROM accessible_condos)::int AS condominiums,
       (SELECT COUNT(DISTINCT unit_id) FROM sensor_scope)::int AS units,
       (SELECT COUNT(*) FROM sensor_scope)::int AS sensors,
       (SELECT COUNT(*) FROM sensor_scope WHERE last_reading_at >= now() - interval '10 minutes')::int AS sensors_online,
       (SELECT COUNT(*) FROM sensor_scope WHERE last_reading_at < now() - interval '30 minutes' OR last_reading_at IS NULL)::int AS sensors_offline,
       COALESCE((SELECT SUM(consumption) FROM month_usage),0)::float8 AS month_consumption_m3,
       COALESCE((SELECT SUM(consumption) FROM today_usage),0)::float8 AS today_consumption_m3`,
    params
  );

  res.json(result.rows[0]);
});

app.get('/api/v1/condominios', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.auth!.sub;
  const isSuper = req.auth!.role === 'superadmin';
  const result = await pool.query(
    isSuper
      ? `SELECT c.id, c.name, c.city, c.state,
                COUNT(DISTINCT b.id)::int AS buildings,
                COUNT(DISTINCT u.id)::int AS units,
                COUNT(DISTINCT s.id)::int AS sensors
           FROM condominiums c
           LEFT JOIN buildings b ON b.condominium_id = c.id
           LEFT JOIN units u ON u.building_id = b.id
           LEFT JOIN sensors s ON s.unit_id = u.id
          GROUP BY c.id ORDER BY c.name`
      : `SELECT c.id, c.name, c.city, c.state,
                COUNT(DISTINCT b.id)::int AS buildings,
                COUNT(DISTINCT u.id)::int AS units,
                COUNT(DISTINCT s.id)::int AS sensors
           FROM condominiums c
           JOIN user_condominiums uc ON uc.condominium_id = c.id AND uc.user_id = $1
           LEFT JOIN buildings b ON b.condominium_id = c.id
           LEFT JOIN units u ON u.building_id = b.id
           LEFT JOIN sensors s ON s.unit_id = u.id
          GROUP BY c.id ORDER BY c.name`,
    isSuper ? [] : [userId]
  );
  res.json(result.rows);
});

app.get('/api/v1/sensores', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.auth!.sub;
  const isSuper = req.auth!.role === 'superadmin';
  const result = await pool.query(
    `SELECT s.id, s.serial, s.sensor_type, s.central_serial, s.conversion_factor,
            s.last_raw_value, s.last_reading_at, s.virtual_counter,
            u.identifier AS unit_identifier, b.name AS building_name, c.name AS condominium_name,
            CASE
              WHEN s.last_reading_at >= now() - interval '10 minutes' THEN 'online'
              WHEN s.last_reading_at >= now() - interval '30 minutes' THEN 'attention'
              ELSE 'offline'
            END AS connection_status
       FROM sensors s
       LEFT JOIN units u ON u.id = s.unit_id
       LEFT JOIN buildings b ON b.id = u.building_id
       LEFT JOIN condominiums c ON c.id = b.condominium_id
      WHERE $1::boolean = true
         OR c.id IN (SELECT condominium_id FROM user_condominiums WHERE user_id = $2)
      ORDER BY s.last_reading_at DESC NULLS LAST, s.serial`,
    [isSuper, userId]
  );
  res.json(result.rows);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const port = Number(process.env.API_PORT ?? 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`[hidrocondo] API ouvindo na porta ${port}`);
});
