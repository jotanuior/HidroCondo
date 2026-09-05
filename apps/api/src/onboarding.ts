import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, signToken, type AuthenticatedRequest } from './auth.js';
import { serialSchema, validateSerialInScae } from './scae-validation.js';

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email(),
  phone: z.string().trim().min(8).max(30).optional().nullable(),
  password: z.string().min(8).max(200),
  serial: serialSchema,
  account_name: z.string().trim().min(2).max(120).optional().nullable()
});

export function registerOnboardingRoutes(app: Express) {
  app.post('/api/v1/auth/autocadastro', async (req, res) => {
    const parsed = registerSchema.safeParse({
      ...req.body,
      serial: String(req.body?.serial ?? '').trim(),
      email: String(req.body?.email ?? '').trim().toLowerCase()
    });
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dados inválidos. Informe nome, e-mail, senha e um serial iniciado por 09.' });
    }

    const p = parsed.data;
    let scae;
    try {
      scae = await validateSerialInScae(p.serial);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao validar sensor no SCAE';
      return res.status(502).json({ error: message });
    }
    if (!scae.ok || !scae.exists) {
      return res.status(400).json({ error: 'Serial não encontrado no SCAE.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingUser = await client.query('SELECT id FROM users WHERE lower(email)=lower($1)', [p.email]);
      if (existingUser.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Este e-mail já possui uma conta. Entre no sistema para adicionar novos equipamentos.' });
      }

      const existingSensor = await client.query('SELECT id,account_id FROM sensors WHERE serial=$1 FOR UPDATE', [p.serial]);
      if (existingSensor.rows[0]?.account_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Este equipamento já está vinculado a uma conta HidroCondo.' });
      }

      const passwordHash = await bcrypt.hash(p.password, 12);
      const userQ = await client.query(
        `INSERT INTO users(name,email,phone,password_hash,role,active)
         VALUES($1,$2,$3,$4,'admin',true)
         RETURNING id,name,email,phone,role,active`,
        [p.name, p.email, p.phone || null, passwordHash]
      );
      const user = userQ.rows[0];

      const accountQ = await client.query(
        `INSERT INTO customer_accounts(name,owner_user_id)
         VALUES($1,$2)
         RETURNING id,name,owner_user_id,created_at`,
        [p.account_name || p.name, user.id]
      );
      const account = accountQ.rows[0];

      await client.query(
        `INSERT INTO account_members(account_id,user_id,role,is_owner)
         VALUES($1,$2,'admin',true)`,
        [account.id, user.id]
      );

      let sensor;
      if (existingSensor.rowCount) {
        const sensorQ = await client.query(
          `UPDATE sensors
              SET account_id=$1,claimed_by=$2,claimed_at=now(),sensor_type='09',active=true,
                  central_serial=COALESCE(central_serial,$3)
            WHERE id=$4
            RETURNING id,serial,sensor_type,account_id,claimed_at,unit_id`,
          [account.id, user.id, scae.central_serial || null, existingSensor.rows[0].id]
        );
        sensor = sensorQ.rows[0];
      } else {
        const sensorQ = await client.query(
          `INSERT INTO sensors(serial,sensor_type,central_serial,account_id,claimed_by,claimed_at,active)
           VALUES($1,'09',$2,$3,$4,now(),true)
           RETURNING id,serial,sensor_type,account_id,claimed_at,unit_id`,
          [p.serial, scae.central_serial || null, account.id, user.id]
        );
        sensor = sensorQ.rows[0];
      }

      await client.query(
        `INSERT INTO access_grants(user_id,scope_type,scope_id,role,created_by)
         VALUES($1,'account',$2,'admin',$1)
         ON CONFLICT DO NOTHING`,
        [user.id, account.id]
      );

      await client.query(
        `INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
         VALUES($1,'self_register_owner','customer_account',$2,$3::jsonb)`,
        [user.id, account.id, JSON.stringify({ serial: p.serial, sensor_id: sensor.id })]
      );

      await client.query('COMMIT');
      const token = signToken({ sub: user.id, email: user.email, role: 'admin' });
      return res.status(201).json({
        token,
        user,
        account,
        sensor,
        onboarding: { needs_condominium: true, needs_installation: true }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof Error && error.message.includes('duplicate key')) {
        return res.status(409).json({ error: 'E-mail ou equipamento já cadastrado.' });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/v1/onboarding/me', requireAuth, async (req: AuthenticatedRequest, res) => {
    const accountQ = await pool.query(
      `SELECT a.id,a.name,a.owner_user_id,am.role,am.is_owner,a.created_at
         FROM account_members am
         JOIN customer_accounts a ON a.id=am.account_id
        WHERE am.user_id=$1
        ORDER BY am.is_owner DESC,a.created_at
        LIMIT 1`,
      [req.auth!.sub]
    );
    const account = accountQ.rows[0] ?? null;
    if (!account) return res.json({ account: null, sensors: [], condominiums: [] });

    const [sensorsQ, condosQ] = await Promise.all([
      pool.query(`SELECT id,serial,sensor_type,active,unit_id,claimed_at,last_reading_at FROM sensors WHERE account_id=$1 ORDER BY claimed_at DESC NULLS LAST,serial`, [account.id]),
      pool.query(`SELECT id,name,document,city,state,created_at FROM condominiums WHERE account_id=$1 ORDER BY name`, [account.id])
    ]);
    res.json({ account, sensors: sensorsQ.rows, condominiums: condosQ.rows });
  });
}
