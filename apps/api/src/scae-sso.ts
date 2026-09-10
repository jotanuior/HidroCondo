import express, { type Express } from 'express';
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

function verifyScaeToken(token: string): string {
  const decoded = jwt.verify(token, scaeJwtSecret(), { algorithms: ['HS512'] });
  if (typeof decoded !== 'object' || decoded === null) throw new Error('SCAE_TOKEN_INVALID');
  const email = extractScaeEmail(decoded as JwtPayload);
  if (!email) throw new Error('SCAE_IDENTITY_INVALID');
  return email;
}

async function findSyncedScaeUser(email: string) {
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
  if (result.rowCount !== 1) return null;
  const user = result.rows[0];
  if (user.scae_registration_status && user.scae_registration_status !== 'COMPLETO') return null;
  return user;
}

function sessionHtml(session: { token: string; user: { id: string; name: string; email: string; role: string } }) {
  const json = JSON.stringify(session).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrando no HidroCondo</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e5eefb;font:16px system-ui,sans-serif}main{max-width:440px;padding:32px;text-align:center}h1{margin:0 0 12px}</style>
</head>
<body><main><h1>HidroCondo</h1><p>Autenticação SCAE concluída. Abrindo o painel...</p></main>
<script id="hc-session" type="application/json">${json}</script>
<script>
const session=JSON.parse(document.getElementById('hc-session').textContent);
localStorage.setItem('hidrocondo.session',JSON.stringify(session));
localStorage.setItem('hidrocondo.frontend','v2');
location.replace('/?v2=1');
</script>
</body></html>`;
}

async function createHidroSessionFromScaeToken(token: string) {
  const email = verifyScaeToken(token);
  const user = await findSyncedScaeUser(email);
  if (!user) return null;
  return {
    token: signToken({ sub: user.id, email: user.email, role: user.role }),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

export function registerScaeSsoRoutes(app: Express) {
  app.post('/api/v1/auth/scae/exchange', async (req, res, next) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token SCAE ausente' });
    try {
      const session = await createHidroSessionFromScaeToken(header.slice(7));
      if (!session) return res.status(403).json({ error: 'Usuário SCAE não sincronizado ou inativo' });
      return res.json({ ...session, source: 'SCAE' });
    } catch (error) {
      if (error instanceof Error && error.message.includes('SCAE_JWT_SECRET')) return next(error);
      return res.status(401).json({ error: 'Token SCAE inválido ou expirado' });
    }
  });

  app.post(
    '/api/v1/auth/scae/start',
    express.urlencoded({ extended: false, limit: '32kb' }),
    async (req, res, next) => {
      const token = typeof req.body?.scae_token === 'string' ? req.body.scae_token : '';
      if (!token) return res.status(401).send('Token SCAE ausente');
      try {
        const session = await createHidroSessionFromScaeToken(token);
        if (!session) return res.status(403).send('Usuário SCAE não sincronizado ou inativo');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
        return res.type('html').send(sessionHtml(session));
      } catch (error) {
        if (error instanceof Error && error.message.includes('SCAE_JWT_SECRET')) return next(error);
        return res.status(401).send('Token SCAE inválido ou expirado');
      }
    }
  );
}
