import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, signToken, type AuthenticatedRequest } from './auth.js';
import { ingestTelemetry } from './telemetry.js';
import { registerManagementRoutes } from './management.js';
import { registerCounterRoutes } from './counter.js';
import { registerAccessRoutes } from './access.js';
import { registerReportRoutes } from './reports.js';
import { registerScopedReadRoutes } from './scoped-read.js';
import { registerUserRoutes } from './users.js';
import { registerScaeRoutes } from './scae.js';
import { registerScaeValidationRoutes } from './scae-validation.js';
import { registerOnboardingRoutes } from './onboarding.js';
import { registerAccountRoutes } from './accounts.js';
import { registerSharingRoutes } from './sharing.js';
import { registerProfileRoutes } from './profile.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

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
    `SELECT id, name, email, password_hash, role FROM users WHERE lower(email)=lower($1) AND active=true`,
    [parsed.data.email]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  }
  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/v1/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  const result = await pool.query('SELECT id,name,email,phone,role,active,created_at FROM users WHERE id=$1', [req.auth!.sub]);
  if (!result.rowCount) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(result.rows[0]);
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

registerOnboardingRoutes(app);
registerProfileRoutes(app);
registerScaeRoutes(app);
registerScopedReadRoutes(app);
registerUserRoutes(app);
registerScaeValidationRoutes(app);
registerAccountRoutes(app);
registerSharingRoutes(app);
registerManagementRoutes(app);
registerCounterRoutes(app);
registerAccessRoutes(app);
registerReportRoutes(app);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  const message = error instanceof Error && error.message.includes('duplicate key') ? 'Registro duplicado' : 'Erro interno do servidor';
  res.status(500).json({ error: message });
});

const port = Number(process.env.API_PORT ?? 3000);
app.listen(port, '0.0.0.0', () => console.log(`[hidrocondo] API ouvindo na porta ${port}`));
