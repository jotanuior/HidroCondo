import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

export function registerProfileRoutes(app: Express) {
  app.patch('/api/v1/me', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().max(30).optional().nullable()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados do perfil inválidos' });

    const result = await pool.query(
      `UPDATE users SET name=$1,phone=$2 WHERE id=$3
       RETURNING id,name,email,phone,role,active,created_at`,
      [parsed.data.name, parsed.data.phone || null, req.auth!.sub]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Usuário não encontrado' });
    await pool.query(
      `INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
       VALUES($1,'update_profile','user',$1,$2::jsonb)`,
      [req.auth!.sub, JSON.stringify({ name: parsed.data.name, phone: parsed.data.phone || null })]
    );
    res.json(result.rows[0]);
  });

  app.post('/api/v1/me/password', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({
      current_password: z.string().min(1),
      new_password: z.string().min(8).max(200)
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Informe a senha atual e uma nova senha com no mínimo 8 caracteres' });
    if (parsed.data.current_password === parsed.data.new_password) {
      return res.status(400).json({ error: 'A nova senha deve ser diferente da senha atual' });
    }

    const q = await pool.query('SELECT password_hash FROM users WHERE id=$1 AND active=true', [req.auth!.sub]);
    if (!q.rowCount || !await bcrypt.compare(parsed.data.current_password, q.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }
    const hash = await bcrypt.hash(parsed.data.new_password, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.auth!.sub]);
    await pool.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [req.auth!.sub]);
    await pool.query(
      `INSERT INTO audit_log(user_id,action,entity_type,entity_id)
       VALUES($1,'change_own_password','user',$1)`,
      [req.auth!.sub]
    );
    res.json({ ok: true });
  });
}
