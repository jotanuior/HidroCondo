import type { NextFunction, Request, Response } from 'express';
import { pool } from './db.js';
import jwt, { type SignOptions } from 'jsonwebtoken';

export type AuthUser = {
  sub: string;
  role: 'superadmin' | 'admin' | 'sindico' | 'zelador' | 'conselheiro' | 'morador';
  email: string;
};

export type AuthenticatedRequest = Request<Record<string, string>> & { auth?: AuthUser };

function jwtSecret(): string {
  const secret=process.env.JWT_SECRET;
  if (!secret || secret === 'dev-secret') throw new Error('JWT_SECRET deve ser configurado');
  return secret;
}

export function signToken(user: AuthUser): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN ?? '7d') as SignOptions['expiresIn'];
  return jwt.sign(user, jwtSecret(), { expiresIn });
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }

  try {
    const decoded = jwt.verify(header.slice(7), jwtSecret()) as AuthUser;
    if (!decoded.sub || !/^[0-9a-f-]{36}$/i.test(decoded.sub)) return res.status(401).json({error:'Sessão inválida'});
    req.auth=decoded;
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  try {
    const q=await pool.query('SELECT id,email,role FROM users WHERE id=$1 AND active=true',[req.auth!.sub]);
    if (!q.rowCount) return res.status(401).json({error:'Usuário inativo ou removido'});
    req.auth={sub:q.rows[0].id,email:q.rows[0].email,role:q.rows[0].role};
    next();
  } catch(error) { next(error); }
}
