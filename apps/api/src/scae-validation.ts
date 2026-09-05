import type { Express } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const serialSchema = z.string().regex(/^09[0-9]+$/, 'Serial inválido');

type ScaeValidationResponse = {
  ok?: boolean;
  exists?: boolean;
  serial?: string | null;
  sensor_type?: string | null;
  last_seen_at?: string | null;
  central_serial?: string | null;
  error?: string;
};

async function validateSerialInScae(serial: string): Promise<ScaeValidationResponse> {
  const url = process.env.SCAE_VALIDATION_URL;
  const user = process.env.SCAE_VALIDATION_USER;
  const password = process.env.SCAE_VALIDATION_PASSWORD;
  const key = process.env.SCAE_VALIDATION_KEY;

  if (!url || !user || !password || !key) {
    throw new Error('Integração de validação SCAE não configurada');
  }

  const auth = Buffer.from(`${user}:${password}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'X-HidroCondo-Key': key
      },
      body: JSON.stringify({ serial }),
      signal: controller.signal
    });

    const text = await response.text();
    let payload: ScaeValidationResponse;

    try {
      payload = JSON.parse(text) as ScaeValidationResponse;
    } catch {
      throw new Error(`Resposta inválida do SCAE (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(payload.error || `SCAE respondeu HTTP ${response.status}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function registerScaeValidationRoutes(app: Express) {
  app.post('/api/v1/scae/validar-sensor', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = serialSchema.safeParse(String(req.body?.serial ?? '').trim());
    if (!parsed.success) {
      return res.status(400).json({ ok: false, exists: false, error: 'Serial inválido. Informe um serial iniciado por 09.' });
    }

    try {
      const result = await validateSerialInScae(parsed.data);
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao validar sensor no SCAE';
      return res.status(502).json({ ok: false, exists: false, error: message });
    }
  });

  app.post('/api/v1/sensores', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    const parsed = serialSchema.safeParse(String(req.body?.serial ?? '').trim());
    if (!parsed.success) {
      return res.status(400).json({ error: 'Serial inválido. Somente sensores iniciados por 09 podem ser cadastrados.' });
    }

    try {
      const result = await validateSerialInScae(parsed.data);
      if (!result.ok || !result.exists) {
        return res.status(400).json({ error: 'Serial não encontrado no SCAE.' });
      }

      req.body.serial = parsed.data;
      req.body.sensor_type = '09';
      if (!req.body.central_serial && result.central_serial) {
        req.body.central_serial = result.central_serial;
      }
      return next();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao validar sensor no SCAE';
      return res.status(502).json({ error: message });
    }
  });
}
