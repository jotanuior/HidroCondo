import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';

const sensorSchema = z.object({
  serial: z.string().min(3).max(100),
  type: z.string().min(1).max(20),
  central_serial: z.string().max(200).nullable().optional(),
  last_seen_at: z.string().datetime({ offset: true }).nullable().optional()
});

const syncSchema = z.object({
  source: z.string().default('SCAE'),
  generated_at: z.string().datetime({ offset: true }),
  sensor_count: z.number().int().nonnegative().optional(),
  sensors: z.array(sensorSchema).max(100000)
});

const condoSchema = z.object({
  scae_condominium_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  permission: z.enum(['ADMIN', 'CONVIDADO'])
});

const userSchema = z.object({
  scae_user_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(2).max(200),
  email: z.string().email(),
  cpf_cnpj: z.string().trim().max(30).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  scae_role: z.string().max(40).nullable().optional(),
  registration_status: z.string().max(40).default('COMPLETO'),
  condominiums: z.array(condoSchema).max(1000).default([])
});

const usersSyncSchema = z.object({
  source: z.literal('SCAE').default('SCAE'),
  generated_at: z.string().datetime({ offset: true }),
  snapshot_complete: z.boolean().default(true),
  users: z.array(userSchema).max(100000)
});

const structureSensorSchema = z.object({
  scae_sensor_id: z.coerce.number().int().positive(),
  serial: z.string().trim().min(3).max(100),
  sensor_type: z.string().trim().min(1).max(40),
  scae_condominium_id: z.coerce.number().int().positive(),
  scae_equipment_id: z.coerce.number().int().positive().nullable().optional(),
  scae_installation_point_id: z.coerce.number().int().positive().nullable().optional(),
  central_serial: z.string().trim().max(200).nullable().optional(),
  active: z.boolean().default(true),
  status: z.string().trim().max(80).nullable().optional()
});

const structureSchema = z.object({
  source: z.literal('SCAE').default('SCAE'),
  generated_at: z.string().datetime({ offset: true }),
  snapshot_complete: z.boolean().default(true),
  installation_points: z.array(z.object({
    scae_installation_point_id: z.coerce.number().int().positive(),
    scae_condominium_id: z.coerce.number().int().positive(),
    description: z.string().trim().min(1).max(200)
  })).max(100000).default([]),
  sensors: z.array(structureSensorSchema).max(100000).default([])
});

function validSyncKey(req: any) {
  const expected = process.env.SCAE_SYNC_API_KEY;
  const supplied = req.header('x-scae-key');
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeCpf(v?: string | null) {
  return v?.replace(/\D/g, '') || null;
}

function isHidroSensor09(type: string, serial: string) {
  return type.trim() === '09' && serial.trim().startsWith('09');
}

function uuidArray(values: string[]) {
  return [...new Set(values)];
}

async function ensureScaeCondominium(client: any, scaeId: number, name: string, ownerUserId?: string | null) {
  let cq = await client.query('SELECT * FROM condominiums WHERE scae_condominium_id=$1 FOR UPDATE', [scaeId]);
  let condo = cq.rows[0];

  if (!condo) {
    const nameConflict = await client.query(
      `SELECT id,name FROM condominiums
       WHERE scae_condominium_id IS NULL
         AND lower(regexp_replace(trim(name),'\\s+',' ','g'))=lower(regexp_replace(trim($1),'\\s+',' ','g'))
       LIMIT 1`,
      [name]
    );
    if (nameConflict.rowCount) return { conflict: true as const, condo: null };

    const account = await client.query(
      'INSERT INTO customer_accounts(name,owner_user_id) VALUES($1,$2) RETURNING id,owner_user_id',
      [name, ownerUserId || null]
    );
    cq = await client.query(
      `INSERT INTO condominiums(name,account_id,scae_condominium_id,source,scae_synced_at)
       VALUES($1,$2,$3,'SCAE',now()) RETURNING *`,
      [name, account.rows[0].id, scaeId]
    );
    condo = cq.rows[0];
  } else {
    if (!condo.account_id) {
      const account = await client.query(
        'INSERT INTO customer_accounts(name,owner_user_id) VALUES($1,$2) RETURNING id',
        [name, ownerUserId || null]
      );
      const updated = await client.query(
        `UPDATE condominiums
         SET name=$2,account_id=$3,
             source=CASE WHEN source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE source END,
             scae_synced_at=now()
         WHERE id=$1 RETURNING *`,
        [condo.id, name, account.rows[0].id]
      );
      condo = updated.rows[0];
    } else {
      const updated = await client.query(
        `UPDATE condominiums
         SET name=$2,
             source=CASE WHEN source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE source END,
             scae_synced_at=now()
         WHERE id=$1 RETURNING *`,
        [condo.id, name]
      );
      condo = updated.rows[0];
    }
  }

  return { conflict: false as const, condo };
}

export function registerScaeRoutes(app: Express) {
  app.post('/api/v1/scae/usuarios/sync', async (req, res) => {
    if (!validSyncKey(req)) return res.status(401).json({ ok: false, error: 'Chave de sincronização SCAE inválida' });

    const parsed = usersSyncSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Payload de usuários SCAE inválido', details: parsed.error.flatten() });
    }

    const client = await pool.connect();
    let created = 0;
    let updated = 0;
    let merged = 0;
    let conflicts = 0;
    let deactivated = 0;
    let grantsRemoved = 0;
    const activeScaeIds: number[] = [];

    try {
      await client.query('BEGIN');

      for (const incoming of parsed.data.users) {
        const email = incoming.email.trim().toLowerCase();
        const cpf = normalizeCpf(incoming.cpf_cnpj);

        let q = await client.query('SELECT * FROM users WHERE scae_user_id=$1 FOR UPDATE', [incoming.scae_user_id]);
        let user = q.rows[0];

        if (incoming.registration_status !== 'COMPLETO') {
          if (user && user.role !== 'superadmin') {
            await client.query(
              `UPDATE users SET active=false,scae_present=true,scae_registration_status=$2,scae_synced_at=now() WHERE id=$1`,
              [user.id, incoming.registration_status]
            );
            deactivated++;
          }
          continue;
        }

        activeScaeIds.push(incoming.scae_user_id);

        if (!user) {
          q = await client.query('SELECT * FROM users WHERE lower(email)=lower($1) FOR UPDATE', [email]);
          user = q.rows[0];
          if (user) merged++;
        }

        if (!user && cpf) {
          const cq = await client.query(
            "SELECT * FROM users WHERE regexp_replace(COALESCE(cpf_cnpj,''),'\\D','','g')=$1 FOR UPDATE",
            [cpf]
          );
          if (cq.rowCount === 1) {
            const candidate = cq.rows[0];
            if (String(candidate.email || '').trim().toLowerCase() !== email) {
              conflicts++;
              continue;
            }
            user = candidate;
            merged++;
          } else if ((cq.rowCount ?? 0) > 1) {
            conflicts++;
            continue;
          }
        }

        if (user) {
          const emailOwner = await client.query(
            'SELECT id FROM users WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1',
            [email, user.id]
          );
          if (emailOwner.rowCount) {
            conflicts++;
            continue;
          }
        }

        const hasAdmin = incoming.condominiums.some((c) => c.permission === 'ADMIN');
        const sourceBefore = user?.source;

        if (user) {
          const nextRole = sourceBefore === 'SCAE' ? (hasAdmin ? 'admin' : 'morador') : user.role;
          const uq = await client.query(
            `UPDATE users
             SET name=$2,email=$3,phone=COALESCE($4,phone),cpf_cnpj=COALESCE($5,cpf_cnpj),
                 scae_user_id=$6,
                 source=CASE WHEN source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE source END,
                 scae_role=$7,scae_registration_status=$8,scae_synced_at=now(),
                 scae_present=true,active=true,role=$9
             WHERE id=$1 RETURNING *`,
            [user.id, incoming.name, email, incoming.phone || null, cpf, incoming.scae_user_id,
              incoming.scae_role || null, incoming.registration_status, nextRole]
          );
          user = uq.rows[0];
          updated++;
        } else {
          const hash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12);
          q = await client.query(
            `INSERT INTO users(name,email,password_hash,role,phone,cpf_cnpj,scae_user_id,source,scae_role,scae_registration_status,scae_synced_at,scae_present,active)
             VALUES($1,$2,$3,$4,$5,$6,$7,'SCAE',$8,$9,now(),true,true) RETURNING *`,
            [incoming.name, email, hash, hasAdmin ? 'admin' : 'morador', incoming.phone || null, cpf,
              incoming.scae_user_id, incoming.scae_role || null, incoming.registration_status]
          );
          user = q.rows[0];
          created++;
        }

        const desiredCondoIds: string[] = [];
        const desiredAccountIds: string[] = [];

        for (const c of incoming.condominiums) {
          const ensured = await ensureScaeCondominium(
            client,
            c.scae_condominium_id,
            c.name,
            c.permission === 'ADMIN' ? user.id : null
          );
          if (ensured.conflict || !ensured.condo) {
            conflicts++;
            continue;
          }

          const condo = ensured.condo;
          desiredCondoIds.push(condo.id);
          if (condo.account_id) desiredAccountIds.push(condo.account_id);
          const scopedRole = c.permission === 'ADMIN' ? 'admin' : 'morador';

          await client.query(
            `INSERT INTO user_condominiums(user_id,condominium_id,source)
             VALUES($1,$2,'SCAE') ON CONFLICT DO NOTHING`,
            [user.id, condo.id]
          );

          await client.query(
            `DELETE FROM access_grants
             WHERE user_id=$1 AND scope_type='condominium' AND scope_id=$2 AND source='SCAE'`,
            [user.id, condo.id]
          );
          await client.query(
            `INSERT INTO access_grants(user_id,scope_type,scope_id,role,source)
             VALUES($1,'condominium',$2,$3,'SCAE') ON CONFLICT DO NOTHING`,
            [user.id, condo.id, scopedRole]
          );

          if (condo.account_id) {
            await client.query(
              `INSERT INTO account_members(account_id,user_id,role,is_owner,source)
               VALUES($1,$2,$3,false,'SCAE')
               ON CONFLICT(account_id,user_id) DO UPDATE SET
                 role=CASE WHEN account_members.source='SCAE' THEN EXCLUDED.role ELSE account_members.role END,
                 source=account_members.source`,
              [condo.account_id, user.id, scopedRole]
            );
          }
        }

        const condoIds = uuidArray(desiredCondoIds);
        const accountIds = uuidArray(desiredAccountIds);

        const rg = await client.query(
          `DELETE FROM access_grants
           WHERE user_id=$1 AND source='SCAE' AND scope_type='condominium'
             AND NOT (scope_id = ANY($2::uuid[]))`,
          [user.id, condoIds]
        );
        grantsRemoved += rg.rowCount ?? 0;

        const rc = await client.query(
          `DELETE FROM user_condominiums
           WHERE user_id=$1 AND source='SCAE'
             AND NOT (condominium_id = ANY($2::uuid[]))`,
          [user.id, condoIds]
        );
        grantsRemoved += rc.rowCount ?? 0;

        const ra = await client.query(
          `DELETE FROM account_members
           WHERE user_id=$1 AND source='SCAE'
             AND NOT (account_id = ANY($2::uuid[]))`,
          [user.id, accountIds]
        );
        grantsRemoved += ra.rowCount ?? 0;
      }

      if (parsed.data.snapshot_complete) {
        const ids = [...new Set(activeScaeIds)];
        const dq = await client.query(
          `UPDATE users
           SET active=false,scae_present=false,scae_synced_at=now()
           WHERE scae_user_id IS NOT NULL
             AND role<>'superadmin'
             AND NOT (scae_user_id = ANY($1::bigint[]))
             AND active=true
           RETURNING id`,
          [ids]
        );
        deactivated += dq.rowCount ?? 0;

        const ga = await client.query(
          `DELETE FROM access_grants g
           USING users u
           WHERE g.user_id=u.id AND g.source='SCAE'
             AND u.scae_user_id IS NOT NULL AND u.active=false`
        );
        grantsRemoved += ga.rowCount ?? 0;

        const gu = await client.query(
          `DELETE FROM user_condominiums uc
           USING users u
           WHERE uc.user_id=u.id AND uc.source='SCAE'
             AND u.scae_user_id IS NOT NULL AND u.active=false`
        );
        grantsRemoved += gu.rowCount ?? 0;

        const gm = await client.query(
          `DELETE FROM account_members am
           USING users u
           WHERE am.user_id=u.id AND am.source='SCAE'
             AND u.scae_user_id IS NOT NULL AND u.active=false`
        );
        grantsRemoved += gm.rowCount ?? 0;
      }

      await client.query(
        `UPDATE account_members am
         SET is_owner=(am.user_id=ca.owner_user_id)
         FROM customer_accounts ca
         WHERE am.account_id=ca.id AND am.source='SCAE'`
      );

      await client.query(
        `INSERT INTO scae_sync_log(entity_type,received_count,created_count,updated_count,merged_count,conflict_count,generated_at)
         VALUES('users',$1,$2,$3,$4,$5,$6)`,
        [parsed.data.users.length, created, updated, merged, conflicts, parsed.data.generated_at]
      );

      await client.query('COMMIT');
      return res.json({
        ok: true,
        received: parsed.data.users.length,
        created,
        updated,
        merged,
        conflicts,
        deactivated,
        grants_removed: grantsRemoved,
        snapshot_complete: parsed.data.snapshot_complete
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/scae/estrutura/sync', async (req, res) => {
    if (!validSyncKey(req)) return res.status(401).json({ ok: false, error: 'Chave de sincronização SCAE inválida' });

    const parsed = structureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Payload de estrutura SCAE inválido', details: parsed.error.flatten() });
    }

    const client = await pool.connect();
    let units = 0;
    let sensors = 0;
    let moved = 0;
    let deactivated = 0;
    let reactivated = 0;
    let conflicts = 0;
    let ignoredSensors = 0;
    const presentSensorIds: number[] = [];

    try {
      await client.query('BEGIN');

      for (const p of parsed.data.installation_points) {
        const cq = await client.query('SELECT id FROM condominiums WHERE scae_condominium_id=$1', [p.scae_condominium_id]);
        if (!cq.rowCount) continue;
        const condoId = cq.rows[0].id;

        let bq = await client.query("SELECT id FROM buildings WHERE condominium_id=$1 AND name='SCAE' LIMIT 1", [condoId]);
        if (!bq.rowCount) {
          bq = await client.query("INSERT INTO buildings(condominium_id,name) VALUES($1,'SCAE') RETURNING id", [condoId]);
        }

        await client.query(
          `INSERT INTO units(building_id,identifier,scae_installation_point_id,source,scae_synced_at)
           VALUES($1,$2,$3,'SCAE',now())
           ON CONFLICT(scae_installation_point_id) WHERE scae_installation_point_id IS NOT NULL
           DO UPDATE SET building_id=EXCLUDED.building_id,identifier=EXCLUDED.identifier,
                         source=CASE WHEN units.source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE units.source END,
                         scae_synced_at=now()`,
          [bq.rows[0].id, p.description, p.scae_installation_point_id]
        );
        units++;
      }

      for (const s of parsed.data.sensors) {
        if (!isHidroSensor09(s.sensor_type, s.serial)) {
          ignoredSensors++;
          continue;
        }

        presentSensorIds.push(s.scae_sensor_id);

        const unitQ = s.scae_installation_point_id
          ? await client.query('SELECT id FROM units WHERE scae_installation_point_id=$1', [s.scae_installation_point_id])
          : { rows: [] };
        const unitId = unitQ.rows[0]?.id ?? null;

        const condoQ = await client.query('SELECT id,account_id FROM condominiums WHERE scae_condominium_id=$1', [s.scae_condominium_id]);
        if (!condoQ.rowCount) continue;
        const accountId = condoQ.rows[0].account_id ?? null;

        let existingQ = await client.query('SELECT * FROM sensors WHERE scae_sensor_id=$1 FOR UPDATE', [s.scae_sensor_id]);
        let existing = existingQ.rows[0];

        if (!existing) {
          const bySerial = await client.query('SELECT * FROM sensors WHERE serial=$1 FOR UPDATE', [s.serial.trim()]);
          if (bySerial.rowCount) {
            existing = bySerial.rows[0];
            if (existing.scae_sensor_id && Number(existing.scae_sensor_id) !== s.scae_sensor_id) {
              conflicts++;
              continue;
            }
          }
        }

        if (existing) {
          const oldUnitId = existing.unit_id ?? null;
          const oldAccountId = existing.account_id ?? null;
          const wasActive = Boolean(existing.active);

          const serialOwner = await client.query(
            'SELECT id FROM sensors WHERE serial=$1 AND id<>$2 LIMIT 1',
            [s.serial.trim(), existing.id]
          );
          if (serialOwner.rowCount) {
            conflicts++;
            continue;
          }

          await client.query(
            `UPDATE sensors
             SET unit_id=$2,serial=$3,sensor_type='09',central_serial=COALESCE($4,central_serial),
                 account_id=$5,scae_sensor_id=$6,scae_equipment_id=$7,
                 source=CASE WHEN source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE source END,
                 scae_synced_at=now(),active=$8,
                 claimed_by=CASE WHEN account_id IS DISTINCT FROM $5 THEN NULL ELSE claimed_by END,
                 claimed_at=CASE WHEN account_id IS DISTINCT FROM $5 THEN NULL ELSE claimed_at END
             WHERE id=$1`,
            [existing.id, unitId, s.serial.trim(), s.central_serial || null, accountId,
              s.scae_sensor_id, s.scae_equipment_id || null, s.active]
          );

          if (oldUnitId !== unitId) {
            await client.query(
              `UPDATE sensor_installations
               SET removed_at=COALESCE(removed_at,now()),reason=COALESCE(reason,'Movido pelo SCAE')
               WHERE sensor_id=$1 AND removed_at IS NULL`,
              [existing.id]
            );
            if (unitId) {
              await client.query(
                `INSERT INTO sensor_installations(sensor_id,unit_id,reason)
                 VALUES($1,$2,'Sincronização SCAE')`,
                [existing.id, unitId]
              );
            }
            moved++;
          } else if (oldAccountId !== accountId || Number(existing.scae_equipment_id || 0) !== Number(s.scae_equipment_id || 0)) {
            moved++;
          }

          if (!wasActive && s.active) reactivated++;
          if (wasActive && !s.active) deactivated++;
        } else {
          const inserted = await client.query(
            `INSERT INTO sensors(unit_id,serial,sensor_type,central_serial,account_id,scae_sensor_id,scae_equipment_id,source,scae_synced_at,active)
             VALUES($1,$2,'09',$3,$4,$5,$6,'SCAE',now(),$7) RETURNING id`,
            [unitId, s.serial.trim(), s.central_serial || null, accountId, s.scae_sensor_id,
              s.scae_equipment_id || null, s.active]
          );
          if (unitId) {
            await client.query(
              `INSERT INTO sensor_installations(sensor_id,unit_id,reason)
               VALUES($1,$2,'Sincronização SCAE')`,
              [inserted.rows[0].id, unitId]
            );
          }
        }

        sensors++;
      }

      if (parsed.data.snapshot_complete) {
        const ids = [...new Set(presentSensorIds)];
        const dq = await client.query(
          `UPDATE sensors
           SET active=false,scae_synced_at=now()
           WHERE scae_sensor_id IS NOT NULL
             AND sensor_type='09'
             AND active=true
             AND NOT (scae_sensor_id = ANY($1::bigint[]))
           RETURNING id`,
          [ids]
        );
        deactivated += dq.rowCount ?? 0;
      }

      await client.query('COMMIT');
      return res.json({
        ok: true,
        units,
        sensors,
        moved,
        deactivated,
        reactivated,
        conflicts,
        ignored_sensors: ignoredSensors,
        sensor_filter: '09',
        snapshot_complete: parsed.data.snapshot_complete
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/scae/sensores/sync', async (req, res) => {
    if (!validSyncKey(req)) return res.status(401).json({ ok: false, error: 'Chave de sincronização SCAE inválida' });

    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Payload de sincronização inválido', details: parsed.error.flatten() });
    }

    const payload = parsed.data;
    const list = payload.sensors.filter((s) => isHidroSensor09(s.type, s.serial));
    if (payload.sensors.length > 0 && list.length === 0) {
      return res.status(400).json({ ok: false, error: 'Nenhum sensor tipo 09 válido recebido' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE scae_sensor_inventory SET scae_present=FALSE,updated_at=now() WHERE sensor_type='09'");
      let inserted = 0;
      let updated = 0;

      for (const s of list) {
        const r = await client.query(
          `INSERT INTO scae_sensor_inventory(serial,sensor_type,central_serial,first_synced_at,last_synced_at,last_seen_at,scae_present,updated_at)
           VALUES($1,'09',$2,now(),now(),$3,TRUE,now())
           ON CONFLICT(serial) DO UPDATE SET
             sensor_type='09',central_serial=COALESCE(EXCLUDED.central_serial,scae_sensor_inventory.central_serial),
             last_synced_at=now(),last_seen_at=COALESCE(EXCLUDED.last_seen_at,scae_sensor_inventory.last_seen_at),
             scae_present=TRUE,updated_at=now()
           RETURNING (xmax=0) inserted`,
          [s.serial.trim(), s.central_serial?.trim() || null, s.last_seen_at ?? null]
        );
        if (r.rows[0]?.inserted) inserted++;
        else updated++;
      }

      const a = await client.query("SELECT count(*)::int count FROM scae_sensor_inventory WHERE sensor_type='09' AND scae_present=FALSE");
      await client.query('COMMIT');
      return res.json({
        ok: true,
        source: payload.source,
        generated_at: payload.generated_at,
        received: list.length,
        ignored: payload.sensors.length - list.length,
        inserted,
        updated,
        absent: a.rows[0]?.count ?? 0,
        sensor_filter: '09'
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
}
