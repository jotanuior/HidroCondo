import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

export async function canManageCondominium(req: AuthenticatedRequest, id: string) {
  if (req.auth?.role === 'superadmin') return true;
  if (req.auth?.role !== 'admin') return false;
  const q = await pool.query(`SELECT 1 FROM condominiums c WHERE c.id=$2 AND (
    c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$1)
    OR c.account_id IN(SELECT account_id FROM account_members WHERE user_id=$1 AND role='admin')
    OR EXISTS(SELECT 1 FROM access_grants g WHERE g.user_id=$1 AND g.role='admin'
      AND ((g.scope_type='account' AND g.scope_id=c.account_id) OR (g.scope_type='condominium' AND g.scope_id=c.id))))`,[req.auth!.sub,id]);
  return q.rowCount === 1;
}

export async function canManageSensor(req: AuthenticatedRequest, id: string) {
  if (req.auth?.role === 'superadmin') return true;
  if (req.auth?.role !== 'admin') return false;
  const q = await pool.query(`SELECT 1 FROM sensors s
    LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN buildings b ON b.id=u.building_id
    WHERE s.id=$2 AND (
      s.account_id IN(SELECT account_id FROM account_members WHERE user_id=$1 AND role='admin')
      OR b.condominium_id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$1)
      OR EXISTS(SELECT 1 FROM access_grants g WHERE g.user_id=$1 AND g.role='admin' AND (
        (g.scope_type='account' AND g.scope_id=s.account_id)
        OR (g.scope_type='condominium' AND g.scope_id=b.condominium_id)
        OR (g.scope_type='building' AND g.scope_id=b.id)
        OR (g.scope_type='unit' AND g.scope_id=u.id)
        OR (g.scope_type='sensor' AND g.scope_id=s.id))))`,[req.auth!.sub,id]);
  return q.rowCount === 1;
}

const settings = z.object({
  serial:z.string().min(2).optional(),sensor_type:z.string().min(1).optional(),
  central_serial:z.string().nullable().optional(),unit_id:z.string().uuid().nullable().optional(),
  conversion_factor:z.coerce.number().finite().positive().optional(),active:z.boolean().optional(),
  counter_digits:z.union([z.literal(3),z.literal(6)]).optional(),
  max_flow_m3_hour:z.number().finite().positive().nullable().optional()
});

export function registerSensorManagementRoutes(app: Express) {
  app.put('/api/v1/sensores/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({error:'Sensor inválido'});
    if (!await canManageSensor(req,req.params.id)) return res.status(403).json({error:'Sem permissão para este equipamento'});
    const p=settings.safeParse(req.body);
    if (!p.success) return res.status(400).json({error:'Configuração inválida'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const q=await client.query('SELECT * FROM sensors WHERE id=$1 FOR UPDATE',[req.params.id]);
      const s=q.rows[0];
      if (!s) { await client.query('ROLLBACK'); return res.status(404).json({error:'Sensor não encontrado'}); }
      const v=p.data;
      if ((v.serial!==undefined && v.serial!==s.serial) || (v.sensor_type!==undefined && v.sensor_type!==s.sensor_type)
        || (v.unit_id!==undefined && v.unit_id!==s.unit_id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Serial e tipo identificam o equipamento. Para alterar a unidade, use Instalar ou Transferir.'});
      }
      const digits=v.counter_digits ?? s.counter_digits;
      if (s.last_raw_value!==null && Number(s.last_raw_value)>=10**digits) {
        await client.query('ROLLBACK'); return res.status(409).json({error:'Confira a leitura bruta antes de reduzir a quantidade de dígitos'});
      }
      const r=await client.query(`UPDATE sensors SET central_serial=$2,conversion_factor=$3,active=$4,
        counter_digits=$5,max_flow_m3_hour=$6 WHERE id=$1 RETURNING *`,
        [s.id,v.central_serial===undefined?s.central_serial:v.central_serial,v.conversion_factor??s.conversion_factor,
         v.active??s.active,digits,v.max_flow_m3_hour===undefined?s.max_flow_m3_hour:v.max_flow_m3_hour]);
      await client.query(`INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload)
        VALUES($1,'update','sensor',$2,$3::jsonb)`,[req.auth!.sub,s.id,JSON.stringify({previous:s,changes:v})]);
      await client.query('COMMIT');res.json(r.rows[0]);
    } catch(e) { await client.query('ROLLBACK');throw e; } finally { client.release(); }
  });
  // Keep endpoint compatibility, but retire equipment instead of deleting readings.
  app.delete('/api/v1/sensores/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({error:'Sensor inválido'});
    if (!await canManageSensor(req,req.params.id)) return res.status(403).json({error:'Sem permissão para este equipamento'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const r=await client.query('UPDATE sensors SET active=false WHERE id=$1 RETURNING id',[req.params.id]);
      if (!r.rowCount) { await client.query('ROLLBACK');return res.status(404).json({error:'Sensor não encontrado'}); }
      await client.query(`INSERT INTO audit_log(user_id,action,entity_type,entity_id)
        VALUES($1,'retire','sensor',$2)`,[req.auth!.sub,req.params.id]);
      await client.query('COMMIT');res.status(204).end();
    } catch(e) { await client.query('ROLLBACK');throw e; } finally { client.release(); }
  });
}
