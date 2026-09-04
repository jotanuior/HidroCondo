import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Express, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, signToken, type AuthenticatedRequest } from './auth.js';

const uuid = z.string().uuid();
const inviteRole = z.enum(['sindico','zelador','conselheiro','morador']);
const isSuper = (req: AuthenticatedRequest) => req.auth?.role === 'superadmin';

function forbidden(res: Response) {
  return res.status(403).json({ error: 'Sem permissão para compartilhar este acesso' });
}

async function condominiumForScope(scopeType: 'condominium'|'unit', scopeId: string) {
  if (scopeType === 'condominium') {
    const q = await pool.query('SELECT id,name FROM condominiums WHERE id=$1', [scopeId]);
    return q.rows[0] ? { id: q.rows[0].id as string, name: q.rows[0].name as string } : null;
  }
  const q = await pool.query(`SELECT c.id,c.name FROM units u JOIN buildings b ON b.id=u.building_id JOIN condominiums c ON c.id=b.condominium_id WHERE u.id=$1`, [scopeId]);
  return q.rows[0] ? { id: q.rows[0].id as string, name: q.rows[0].name as string } : null;
}

async function canManageCondo(req: AuthenticatedRequest, condominiumId: string) {
  if (isSuper(req)) return true;
  if (!['admin','sindico'].includes(req.auth?.role ?? '')) return false;
  const q = await pool.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM user_condominiums WHERE user_id=$1 AND condominium_id=$2) OR EXISTS(SELECT 1 FROM access_grants WHERE user_id=$1 AND scope_type='condominium' AND scope_id=$2 AND role IN ('admin','sindico'))`, [req.auth!.sub, condominiumId]);
  return q.rowCount === 1;
}

async function inviteDetailsByHash(hash: string) {
  const q = await pool.query(`
    SELECT i.id,i.scope_type,i.scope_id,i.role,i.invited_email,i.expires_at,i.used_at,i.revoked_at,
           CASE WHEN i.scope_type='unit' THEN u.identifier ELSE NULL END unit_identifier,
           CASE WHEN i.scope_type='unit' THEN b.name ELSE NULL END building_name,
           c.id condominium_id,c.name condominium_name
      FROM access_invitations i
      LEFT JOIN units u ON i.scope_type='unit' AND u.id=i.scope_id
      LEFT JOIN buildings b ON b.id=u.building_id
      LEFT JOIN condominiums c ON c.id=CASE WHEN i.scope_type='condominium' THEN i.scope_id ELSE b.condominium_id END
     WHERE i.token_hash=$1`, [hash]);
  return q.rows[0] ?? null;
}

function invitationState(row: any) {
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export function registerAccessRoutes(app: Express) {
  app.post('/api/v1/convites', requireAuth, async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({
      scope_type: z.enum(['condominium','unit']),
      scope_id: uuid,
      role: inviteRole,
      invited_email: z.string().email().optional().nullable(),
      expires_hours: z.coerce.number().int().min(1).max(720).default(72)
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados do convite inválidos' });
    const p = parsed.data;
    if (p.scope_type === 'unit' && p.role !== 'morador') return res.status(400).json({ error: 'Convite de unidade deve usar o perfil morador' });
    if (p.scope_type === 'condominium' && p.role === 'morador') return res.status(400).json({ error: 'Morador deve receber convite de uma unidade específica' });

    const condo = await condominiumForScope(p.scope_type, p.scope_id);
    if (!condo) return res.status(404).json({ error: 'Unidade ou condomínio não encontrado' });
    if (!await canManageCondo(req, condo.id)) return forbidden(res);

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + p.expires_hours * 3600_000);
    const inserted = await pool.query(`INSERT INTO access_invitations(token_hash,created_by,scope_type,scope_id,role,invited_email,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,expires_at`, [tokenHash, req.auth!.sub, p.scope_type, p.scope_id, p.role, p.invited_email?.toLowerCase() ?? null, expiresAt]);
    await pool.query(`INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,'create_invite','access_invitation',$2,$3::jsonb)`, [req.auth!.sub, inserted.rows[0].id, JSON.stringify({ scope_type: p.scope_type, scope_id: p.scope_id, role: p.role, invited_email: p.invited_email ?? null })]);

    const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
    const host = req.header('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
    const url = `${proto}://${host}/convite/${token}`;
    const target = p.scope_type === 'unit' ? `${condo.name} · unidade` : condo.name;
    const text = `Você recebeu um convite para acessar o HidroCondo (${target}). ${url}`;
    res.status(201).json({ id: inserted.rows[0].id, url, token, expires_at: inserted.rows[0].expires_at, whatsapp_text: text, email_subject: 'Convite de acesso ao HidroCondo', email_body: text });
  });

  app.get('/api/v1/convites/:token', async (req, res) => {
    const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const row = await inviteDetailsByHash(hash);
    if (!row) return res.status(404).json({ error: 'Convite não encontrado' });
    const state = invitationState(row);
    res.status(state === 'active' ? 200 : 410).json({
      state,
      scope_type: row.scope_type,
      role: row.role,
      invited_email: row.invited_email,
      expires_at: row.expires_at,
      condominium: { id: row.condominium_id, name: row.condominium_name },
      unit: row.scope_type === 'unit' ? { id: row.scope_id, identifier: row.unit_identifier, building_name: row.building_name } : null
    });
  });

  app.post('/api/v1/convites/:token/aceitar', async (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), password: z.string().min(8).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios' });
    const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inviteQ = await client.query('SELECT * FROM access_invitations WHERE token_hash=$1 FOR UPDATE', [hash]);
      const invite = inviteQ.rows[0];
      if (!invite) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Convite não encontrado' }); }
      if (invitationState(invite) !== 'active') { await client.query('ROLLBACK'); return res.status(410).json({ error: 'Convite expirado, utilizado ou cancelado' }); }
      const email = parsed.data.email.toLowerCase();
      if (invite.invited_email && invite.invited_email.toLowerCase() !== email) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Este convite foi enviado para outro e-mail' }); }

      let userQ = await client.query('SELECT id,name,email,password_hash,role,active FROM users WHERE lower(email)=lower($1)', [email]);
      let user = userQ.rows[0];
      if (user) {
        if (!user.active || !await bcrypt.compare(parsed.data.password, user.password_hash)) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Conta existente: informe a senha correta para adicionar este acesso' }); }
      } else {
        const hashPassword = await bcrypt.hash(parsed.data.password, 12);
        const baseRole = invite.scope_type === 'unit' ? 'morador' : invite.role;
        userQ = await client.query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role,active', [parsed.data.name, email, hashPassword, baseRole]);
        user = userQ.rows[0];
      }

      await client.query(`INSERT INTO access_grants(user_id,scope_type,scope_id,role,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [user.id, invite.scope_type, invite.scope_id, invite.role, invite.created_by]);
      if (invite.scope_type === 'condominium') await client.query('INSERT INTO user_condominiums(user_id,condominium_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [user.id, invite.scope_id]);
      await client.query('UPDATE access_invitations SET used_at=now(),used_by=$2 WHERE id=$1', [invite.id, user.id]);
      await client.query(`INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,'accept_invite','access_invitation',$2,$3::jsonb)`, [user.id, invite.id, JSON.stringify({ scope_type: invite.scope_type, scope_id: invite.scope_id, role: invite.role })]);
      await client.query('COMMIT');
      const token = signToken({ sub: user.id, email: user.email, role: user.role });
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, access_added: { scope_type: invite.scope_type, scope_id: invite.scope_id, role: invite.role } });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/v1/acessos/me', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (isSuper(req)) return res.json([{ scope_type: 'global', role: 'superadmin' }]);
    const q = await pool.query(`
      SELECT ag.id,ag.scope_type,ag.scope_id,ag.role,
             CASE WHEN ag.scope_type='condominium' THEN c.name ELSE c2.name END condominium_name,
             CASE WHEN ag.scope_type='unit' THEN u.identifier ELSE NULL END unit_identifier,
             CASE WHEN ag.scope_type='unit' THEN b.name ELSE NULL END building_name
        FROM access_grants ag
        LEFT JOIN condominiums c ON ag.scope_type='condominium' AND c.id=ag.scope_id
        LEFT JOIN units u ON ag.scope_type='unit' AND u.id=ag.scope_id
        LEFT JOIN buildings b ON b.id=u.building_id
        LEFT JOIN condominiums c2 ON c2.id=b.condominium_id
       WHERE ag.user_id=$1 ORDER BY condominium_name,building_name,unit_identifier`, [req.auth!.sub]);
    res.json(q.rows);
  });

  app.get('/api/v1/convites', requireAuth, async (req: AuthenticatedRequest, res) => {
    const q = await pool.query(`SELECT i.id,i.scope_type,i.scope_id,i.role,i.invited_email,i.expires_at,i.used_at,i.revoked_at,i.created_at FROM access_invitations i WHERE $1::boolean OR i.created_by=$2 ORDER BY i.created_at DESC LIMIT 200`, [isSuper(req), req.auth!.sub]);
    res.json(q.rows.map((r:any) => ({ ...r, state: invitationState(r) })));
  });

  app.delete('/api/v1/convites/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    const id = req.params.id;
    const q = await pool.query('SELECT created_by,scope_type,scope_id FROM access_invitations WHERE id=$1', [id]);
    if (!q.rowCount) return res.status(404).json({ error: 'Convite não encontrado' });
    if (!isSuper(req) && q.rows[0].created_by !== req.auth!.sub) return forbidden(res);
    await pool.query('UPDATE access_invitations SET revoked_at=now() WHERE id=$1 AND used_at IS NULL', [id]);
    res.status(204).end();
  });
}
