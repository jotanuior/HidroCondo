import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export type AuthUser = {
  sub: string;
  role: 'superadmin' | 'admin' | 'sindico' | 'zelador' | 'conselheiro' | 'morador';
  email: string;
};

export type AuthenticatedRequest = Request<Record<string, string>> & { auth?: AuthUser };

export function signToken(user: AuthUser): string {
  return jwt.sign(user, process.env.JWT_SECRET ?? 'dev-secret', { expiresIn: '12h' });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }

  try {
    req.auth = jwt.verify(header.slice(7), process.env.JWT_SECRET ?? 'dev-secret') as AuthUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}
