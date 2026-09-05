import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Express, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, signToken, type AuthenticatedRequest } from './auth.js';

const uuid = z.string().uuid();
const scopeSchema = z.enum(['account','condominium','building','unit','sensor']);
const roleSchema = z.enum(['admin','sindico','zelador','conselheiro','morador']);

function forbidden(res: Response) {
  return res.status(403).json({ error: 'Sem permissão para compartilhar este acesso' });
}

async function resolveScope(scopeType: string, scopeId: string) {
  if (scopeType === 'account') {
    const q = await pool.query('SELECT id account_id,name label FROM customer_accounts WHERE id=$1', [scopeId]);
    return q.rows[0] ?? null;
  }
  if (scopeType === 'condominium') {
    const q = await pool.query('SELECT id,account_id,name label FROM condominiums WHERE id=$1', [scopeId]);
    return q.rows[0] ?? null;
  }
  if (scopeType === 'building') {
    const q = await pool.query(`SELECT b.id,c.account_id,c.id condominium_id,(c.name||' · '||b.name) label FROM buildings b JOIN condominiums c ON c.id=b.condominium_id WHERE b.id=$1`, [scopeId]);
    return q.rows[0] ?? null;
  }
  if (scopeType === 'unit') {
    const q = await pool.query(`SELECT u.id,c.account_id,c.id condominium_id,b.id building_id,(c.name||' · '||b.name||' · '||u.identifier) label FROM units u JOIN buildings b ON b.id=u.building_id JOIN condominiums c ON c.id=b.condominium_id WHERE u.id=$1`, [scopeId]);
    return q.rows[0] ?? null;
  }
  const q = await pool.query(`SELECT s.id,s.account_id,c.id condominium_id,b.id building_id,u.id unit_id,('Sensor '||s.serial) label FROM sensors s LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN buildings b ON b.id=u.building_id LEFT JOIN condominiums c ON c.id=b.condominium_id WHERE s.id=$1`, [scopeId]);
  return q.rows[0] ?? null;
}

async function canShare(req: AuthenticatedRequest, scope: any) {
  if (req.auth?.role === 'superadmin') return true;
  if (scope.account_id) {
    const member = await pool.query(`SELECT 1 FROM account_members WHERE user_id=$1 AND account_id=$2 AND role='admin'`, [req.auth!.sub, scope.account_id]);
    if (member.rowCount) return true;
  }
  if (scope.condominium_id && ['admin','sindico'].includes(req.auth?.role ?? '')) {
    const grant = await pool.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM user_condominiums WHERE user_id=$1 AND condominium_id=$2) OR EXISTS(SELECT 1 FROM access_grants WHERE user_id=$1 AND scope_type='condominium' AND scope_id=$2 AND role IN ('admin','sindico'))`, [req.auth!.sub, scope.condominium_id]);
    if (grant.rowCount) return true;
  }
  return false;
}

function invitationState(row: any) {
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export function registerSharingRoutes(app: Express) {
  app.post('/api/v1/compartilhamentos', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({
      scope_type: scopeSchema,
      scope_id: uuid,
      role: roleSchema,
      invited_email: z.string().email().optional().nullable(),
      expires_hours: z.coerce.number().int().min(1).max(720).default(72)
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados do compartilhamento inválidos' });
    const p = parsed.data;
    const scope = await resolveScope(p.scope_type, p.scope_id);
    if (!scope) return res.status(404).json({ error: 'Escopo não encontrado' });
    if (!await canShare(req, scope)) return forbidden(res);
    if (req.auth?.role === 'sindico' && p.role === 'admin') return forbidden(res);

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + p.expires_hours * 3600_000);
    const q = await pool.query(
      `INSERT INTO access_invitations(token_hash,created_by,scope_type,scope_id,role,invited_email,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,expires_at`,
      [tokenHash, req.auth!.sub, p.scope_type, p.scope_id, p.role, p.invited_email?.toLowerCase() ?? null, expiresAt]
    );
    const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
    const host = req.header('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
    const url = `${proto}://${host}/convite.html?token=${encodeURIComponent(token)}`;
    const text = `Você recebeu acesso ao HidroCondo (${scope.label}). ${url}`;
    res.status(201).json({ id: q.rows[0].id, url, token, expires_at: q.rows[0].expires_at, scope_type: p.scope_type, role: p.role, whatsapp_text: text });
  });

  app.get('/api/v1/compartilhamentos/:token', async (req, res) => {
    const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const q = await pool.query('SELECT id,scope_type,scope_id,role,invited_email,expires_at,used_at,revoked_at FROM access_invitations WHERE token_hash=$1', [hash]);
    const row = q.rows[0];
    if (!row) return res.status(404).json({ error: 'Convite não encontrado' });
    const state = invitationState(row);
    const scope = await resolveScope(row.scope_type, row.scope_id);
    return res.status(state === 'active' ? 200 : 410).json({ state, role: row.role, scope_type: row.scope_type, scope, invited_email: row.invited_email, expires_at: row.expires_at });
  });

  app.post('/api/v1/compartilhamentos/:token/aceitar', async (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), password: z.string().min(8).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios' });
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const iq = await client.query('SELECT * FROM access_invitations WHERE token_hash=$1 FOR UPDATE', [tokenHash]);
      const invite = iq.rows[0];
      if (!invite) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Convite não encontrado' }); }
      if (invitationState(invite) !== 'active') { await client.query('ROLLBACK'); return res.status(410).json({ error: 'Convite expirado, utilizado ou cancelado' }); }
      const email = parsed.data.email.toLowerCase();
      if (invite.invited_email && invite.invited_email.toLowerCase() !== email) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Este convite foi enviado para outro e-mail' }); }

      let uq = await client.query('SELECT id,name,email,password_hash,role,active FROM users WHERE lower(email)=lower($1)', [email]);
      let user = uq.rows[0];
      if (user) {
        if (!user.active || !await bcrypt.compare(parsed.data.password, user.password_hash)) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Conta existente: informe a senha correta para adicionar este acesso' }); }
      } else {
        const passwordHash = await bcrypt.hash(parsed.data.password, 12);
        uq = await client.query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role,active', [parsed.data.name,email,passwordHash,invite.role]);
        user = uq.rows[0];
      }

      await client.query(`INSERT INTO access_grants(user_id,scope_type,scope_id,role,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [user.id,invite.scope_type,invite.scope_id,invite.role,invite.created_by]);
      if (invite.scope_type === 'account') {
        await client.query(`INSERT INTO account_members(account_id,user_id,role,is_owner) VALUES($1,$2,$3,false) ON CONFLICT(account_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [invite.scope_id,user.id,invite.role]);
      }
      if (invite.scope_type === 'condominium' && invite.role !== 'morador') {
        await client.query('INSERT INTO user_condominiums(user_id,condominium_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [user.id,invite.scope_id]);
      }
      await client.query('UPDATE access_invitations SET used_at=now(),used_by=$2 WHERE id=$1', [invite.id,user.id]);
      await client.query(`INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,'accept_share','access_invitation',$2,$3::jsonb)`, [user.id,invite.id,JSON.stringify({scope_type:invite.scope_type,scope_id:invite.scope_id,role:invite.role})]);
      await client.query('COMMIT');
      const token = signToken({ sub:user.id,email:user.email,role:user.role });
      return res.json({ token,user:{id:user.id,name:user.name,email:user.email,role:user.role},access_added:{scope_type:invite.scope_type,scope_id:invite.scope_id,role:invite.role} });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
