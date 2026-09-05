import type { Express, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';
import { serialSchema, validateSerialInScae } from './scae-validation.js';

const uuid = z.string().uuid();
const isSuper = (req: AuthenticatedRequest) => req.auth?.role === 'superadmin';

async function accountForUser(userId: string) {
  const q = await pool.query(
    `SELECT a.id,a.name,am.role,am.is_owner
       FROM account_members am
       JOIN customer_accounts a ON a.id=am.account_id
      WHERE am.user_id=$1
      ORDER BY am.is_owner DESC,a.created_at
      LIMIT 1`,
    [userId]
  );
  return q.rows[0] ?? null;
}

function forbidden(res: Response) {
  return res.status(403).json({ error: 'Sem permissão para esta operação' });
}

export function registerAccountRoutes(app: Express) {
  // Intercepta criação de condomínio para clientes auto cadastrados.
  // Superadmin/legado segue para as rotas de management.ts.
  app.post('/api/v1/condominios', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    if (isSuper(req)) return next();
    const account = await accountForUser(req.auth!.sub);
    if (!account) return next();
    if (account.role !== 'admin') return forbidden(res);

    const parsed = z.object({
      name: z.string().trim().min(2),
      document: z.string().optional().nullable(),
      city: z.string().optional().nullable(),
      state: z.string().max(2).optional().nullable()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

    const p = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO condominiums(account_id,name,document,city,state)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [account.id, p.name, p.document || null, p.city || null, p.state?.toUpperCase() || null]
      );
      const condo = r.rows[0];
      await client.query(
        'INSERT INTO user_condominiums(user_id,condominium_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [req.auth!.sub, condo.id]
      );
      await client.query(
        `INSERT INTO access_grants(user_id,scope_type,scope_id,role,created_by)
         VALUES($1,'condominium',$2,'admin',$1) ON CONFLICT DO NOTHING`,
        [req.auth!.sub, condo.id]
      );
      await client.query(
        `INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
         VALUES($1,'create','condominium',$2,$3::jsonb)`,
        [req.auth!.sub, condo.id, JSON.stringify(p)]
      );
      await client.query('COMMIT');
      return res.status(201).json(condo);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/sensores/claim', requireAuth, async (req: AuthenticatedRequest, res) => {
    const account = await accountForUser(req.auth!.sub);
    if (!account || account.role !== 'admin') return forbidden(res);
    const parsed = serialSchema.safeParse(String(req.body?.serial ?? '').trim());
    if (!parsed.success) return res.status(400).json({ error: 'Serial inválido. Informe um serial iniciado por 09.' });

    let scae;
    try {
      scae = await validateSerialInScae(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao validar sensor no SCAE';
      return res.status(502).json({ error: message });
    }
    if (!scae.ok || !scae.exists) return res.status(400).json({ error: 'Serial não encontrado no SCAE.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT id,account_id FROM sensors WHERE serial=$1 FOR UPDATE', [parsed.data]);
      if (found.rows[0]?.account_id && found.rows[0].account_id !== account.id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Este equipamento já está vinculado a outra conta HidroCondo.' });
      }
      let sensor;
      if (found.rowCount) {
        const q = await client.query(
          `UPDATE sensors SET account_id=$1,claimed_by=COALESCE(claimed_by,$2),claimed_at=COALESCE(claimed_at,now()),sensor_type='09',active=true,
                              central_serial=COALESCE(central_serial,$3)
            WHERE id=$4 RETURNING *`,
          [account.id, req.auth!.sub, scae.central_serial || null, found.rows[0].id]
        );
        sensor = q.rows[0];
      } else {
        const q = await client.query(
          `INSERT INTO sensors(serial,sensor_type,central_serial,account_id,claimed_by,claimed_at,active)
           VALUES($1,'09',$2,$3,$4,now(),true) RETURNING *`,
          [parsed.data, scae.central_serial || null, account.id, req.auth!.sub]
        );
        sensor = q.rows[0];
      }
      await client.query(
        `INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
         VALUES($1,'claim','sensor',$2,$3::jsonb)`,
        [req.auth!.sub, sensor.id, JSON.stringify({ serial: parsed.data, account_id: account.id })]
      );
      await client.query('COMMIT');
      return res.status(201).json({ ok: true, sensor });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/sensores/:id/instalar', requireAuth, async (req: AuthenticatedRequest, res) => {
    const sensorId = req.params.id;
    const parsed = z.object({ unit_id: uuid, reason: z.string().trim().max(500).optional().nullable() }).safeParse(req.body);
    if (!uuid.safeParse(sensorId).success || !parsed.success) return res.status(400).json({ error: 'Dados inválidos' });
    const account = await accountForUser(req.auth!.sub);
    if (!account || !['admin','sindico'].includes(account.role)) return forbidden(res);

    const scope = await pool.query(
      `SELECT s.id sensor_id,s.account_id,u.id unit_id,c.account_id unit_account_id
         FROM sensors s, units u
         JOIN buildings b ON b.id=u.building_id
         JOIN condominiums c ON c.id=b.condominium_id
        WHERE s.id=$1 AND u.id=$2`,
      [sensorId, parsed.data.unit_id]
    );
    const row = scope.rows[0];
    if (!row) return res.status(404).json({ error: 'Sensor ou unidade não encontrado' });
    if (row.account_id !== account.id || row.unit_account_id !== account.id) return forbidden(res);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const active = await client.query('SELECT id,unit_id FROM sensor_installations WHERE sensor_id=$1 AND removed_at IS NULL FOR UPDATE', [sensorId]);
      if (active.rows[0]?.unit_id === parsed.data.unit_id) {
        await client.query('ROLLBACK');
        return res.json({ ok: true, already_installed: true, sensor_id: sensorId, unit_id: parsed.data.unit_id });
      }
      if (active.rowCount) {
        await client.query(
          `UPDATE sensor_installations SET removed_at=now(),removed_by=$1,reason=COALESCE($2,reason) WHERE id=$3`,
          [req.auth!.sub, parsed.data.reason || 'Transferência de unidade', active.rows[0].id]
        );
      }
      const installation = await client.query(
        `INSERT INTO sensor_installations(sensor_id,unit_id,installed_by,reason)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [sensorId, parsed.data.unit_id, req.auth!.sub, parsed.data.reason || null]
      );
      await client.query('UPDATE sensors SET unit_id=$1,active=true WHERE id=$2', [parsed.data.unit_id, sensorId]);
      await client.query(
        `INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
         VALUES($1,'install','sensor',$2,$3::jsonb)`,
        [req.auth!.sub, sensorId, JSON.stringify({ unit_id: parsed.data.unit_id, reason: parsed.data.reason || null })]
      );
      await client.query('COMMIT');
      return res.status(201).json({ ok: true, installation: installation.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/sensores/:id/remover', requireAuth, async (req: AuthenticatedRequest, res) => {
    const sensorId = req.params.id;
    if (!uuid.safeParse(sensorId).success) return res.status(400).json({ error: 'Sensor inválido' });
    const account = await accountForUser(req.auth!.sub);
    if (!account || !['admin','sindico'].includes(account.role)) return forbidden(res);
    const sensor = await pool.query('SELECT id,account_id FROM sensors WHERE id=$1', [sensorId]);
    if (!sensor.rowCount) return res.status(404).json({ error: 'Sensor não encontrado' });
    if (sensor.rows[0].account_id !== account.id) return forbidden(res);
    const reason = String(req.body?.reason ?? '').trim() || 'Remoção do equipamento';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE sensor_installations SET removed_at=now(),removed_by=$1,reason=$2
          WHERE sensor_id=$3 AND removed_at IS NULL`,
        [req.auth!.sub, reason, sensorId]
      );
      await client.query('UPDATE sensors SET unit_id=NULL WHERE id=$1', [sensorId]);
      await client.query(
        `INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
         VALUES($1,'remove_installation','sensor',$2,$3::jsonb)`,
        [req.auth!.sub, sensorId, JSON.stringify({ reason })]
      );
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/v1/sensores/:id/instalacoes', requireAuth, async (req: AuthenticatedRequest, res) => {
    const sensorId = req.params.id;
    if (!uuid.safeParse(sensorId).success) return res.status(400).json({ error: 'Sensor inválido' });
    const q = await pool.query(
      `SELECT si.id,si.sensor_id,si.unit_id,si.installed_at,si.removed_at,si.reason,
              u.identifier unit_identifier,b.name building_name,c.id condominium_id,c.name condominium_name,
              iu.name installed_by_name,ru.name removed_by_name
         FROM sensor_installations si
         JOIN units u ON u.id=si.unit_id
         JOIN buildings b ON b.id=u.building_id
         JOIN condominiums c ON c.id=b.condominium_id
         JOIN sensors s ON s.id=si.sensor_id
         LEFT JOIN users iu ON iu.id=si.installed_by
         LEFT JOIN users ru ON ru.id=si.removed_by
        WHERE si.sensor_id=$1
          AND ($2::boolean OR s.account_id IN (SELECT account_id FROM account_members WHERE user_id=$3)
               OR c.id IN (SELECT condominium_id FROM user_condominiums WHERE user_id=$3))
        ORDER BY si.installed_at DESC`,
      [sensorId, isSuper(req), req.auth!.sub]
    );
    res.json(q.rows);
  });
}
