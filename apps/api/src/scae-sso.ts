import type { Express } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { pool } from './db.js';
import { signToken } from './auth.js';

function scaeJwtSecret(): string {
  const secret = process.env.SCAE_JWT_SECRET;
  if (!secret) throw new Error('SCAE_JWT_SECRET deve ser configurado');
  return secret;
}

function extractScaeEmail(payload: JwtPayload): string | null {
  const candidates = [payload.sub, payload.email];
  for (const value of candidates) {
    if (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

export function registerScaeSsoRoutes(app: Express) {
  app.post('/api/v1/auth/scae/exchange', async (req, res, next) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token SCAE ausente' });
    }

    let email: string | null = null;
    try {
      const decoded = jwt.verify(header.slice(7), scaeJwtSecret(), {
        algorithms: ['HS512'],
      });
      if (typeof decoded !== 'object' || decoded === null) {
        return res.status(401).json({ error: 'Token SCAE inválido' });
      }
      email = extractScaeEmail(decoded as JwtPayload);
      if (!email) return res.status(401).json({ error: 'Identidade SCAE inválida' });
    } catch (error) {
      if (error instanceof Error && error.message.includes('SCAE_JWT_SECRET')) return next(error);
      return res.status(401).json({ error: 'Token SCAE inválido ou expirado' });
    }

    try {
      const result = await pool.query(
        `SELECT id,name,email,role,scae_user_id,source,scae_registration_status
           FROM users
          WHERE lower(email)=lower($1)
            AND active=true
            AND scae_user_id IS NOT NULL
            AND source IN ('SCAE','HIDROCONDO+SCAE')
          LIMIT 2`,
        [email]
      );

      if (result.rowCount !== 1) {
        return res.status(403).json({ error: 'Usuário SCAE não sincronizado ou identidade ambígua' });
      }

      const user = result.rows[0];
      if (user.scae_registration_status && user.scae_registration_status !== 'COMPLETO') {
        return res.status(403).json({ error: 'Cadastro SCAE não está ativo' });
      }

      const token = signToken({ sub: user.id, email: user.email, role: user.role });
      return res.json({
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        source: 'SCAE',
      });
    } catch (error) {
      next(error);
    }
  });
}
