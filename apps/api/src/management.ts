import type { Express, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid = z.string().uuid();
const roleSchema = z.enum(['superadmin','admin','sindico','conselheiro','morador']);

function isManager(req: AuthenticatedRequest) {
  return req.auth?.role === 'superadmin' || req.auth?.role === 'admin';
}
function isSuper(req: AuthenticatedRequest) { return req.auth?.role === 'superadmin'; }
function forbidden(res: Response) { return res.status(403).json({ error: 'Sem permissão para esta operação' }); }

async function canAccessCondo(req: AuthenticatedRequest, condoId: string) {
  if (isSuper(req)) return true;
  const q = await pool.query('SELECT 1 FROM user_condominiums WHERE user_id=$1 AND condominium_id=$2', [req.auth!.sub, condoId]);
  return q.rowCount === 1;
}

async function audit(req: AuthenticatedRequest, action: string, entityType: string, entityId: string, payload?: unknown) {
  await pool.query(
    'INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5)',
    [req.auth?.sub ?? null, action, entityType, entityId, payload ? JSON.stringify(payload) : null]
  );
}

export function registerManagementRoutes(app: Express) {
  app.get('/api/v1/dashboard/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
    const superUser = isSuper(req);
    const params = superUser ? [] : [req.auth!.sub];
    const access = superUser ? 'TRUE' : 'c.id IN (SELECT condominium_id FROM user_condominiums WHERE user_id=$1)';
    const result = await pool.query(`
      WITH accessible_condos AS (SELECT c.id FROM condominiums c WHERE ${access}),
      sensor_scope AS (
        SELECT s.id,s.last_reading_at,u.id unit_id,b.condominium_id FROM sensors s
        LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN buildings b ON b.id=u.building_id
        WHERE b.condominium_id IN (SELECT id FROM accessible_condos)
      )
      SELECT
        (SELECT COUNT(*) FROM accessible_condos)::int condominiums,
        (SELECT COUNT(DISTINCT unit_id) FROM sensor_scope)::int units,
        (SELECT COUNT(*) FROM sensor_scope)::int sensors,
        (SELECT COUNT(*) FROM sensor_scope WHERE last_reading_at>=now()-interval '10 minutes')::int sensors_online,
        (SELECT COUNT(*) FROM sensor_scope WHERE last_reading_at<now()-interval '30 minutes' OR last_reading_at IS NULL)::int sensors_offline,
        COALESCE((SELECT SUM(consumption_m3) FROM telemetry_readings WHERE received_at>=date_trunc('month',now()) AND sensor_id IN(SELECT id FROM sensor_scope)),0)::float8 month_consumption_m3,
        COALESCE((SELECT SUM(consumption_m3) FROM telemetry_readings WHERE received_at>=date_trunc('day',now()) AND sensor_id IN(SELECT id FROM sensor_scope)),0)::float8 today_consumption_m3
    `, params);
    res.json(result.rows[0]);
  });

  app.get('/api/v1/dashboard/series', requireAuth, async (req: AuthenticatedRequest, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14)));
    const result = await pool.query(`
      WITH scope AS (
        SELECT s.id FROM sensors s
        LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN buildings b ON b.id=u.building_id LEFT JOIN condominiums c ON c.id=b.condominium_id
        WHERE $1::boolean OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
      ), dates AS (SELECT generate_series(current_date-($3::int-1),current_date,'1 day')::date day)
      SELECT d.day,COALESCE(SUM(t.consumption_m3),0)::float8 consumption_m3
      FROM dates d LEFT JOIN telemetry_readings t ON t.received_at>=d.day AND t.received_at<d.day+interval '1 day' AND t.sensor_id IN(SELECT id FROM scope)
      GROUP BY d.day ORDER BY d.day`, [isSuper(req), req.auth!.sub, days]);
    res.json(result.rows);
  });

  app.get('/api/v1/condominios', requireAuth, async (req: AuthenticatedRequest, res) => {
    const result = await pool.query(`SELECT c.id,c.name,c.document,c.city,c.state,c.created_at,
      COUNT(DISTINCT b.id)::int buildings,COUNT(DISTINCT u.id)::int units,COUNT(DISTINCT s.id)::int sensors
      FROM condominiums c LEFT JOIN buildings b ON b.condominium_id=c.id LEFT JOIN units u ON u.building_id=b.id LEFT JOIN sensors s ON s.unit_id=u.id
      WHERE $1::boolean OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2)
      GROUP BY c.id ORDER BY c.name`, [isSuper(req), req.auth!.sub]);
    res.json(result.rows);
  });

  app.post('/api/v1/condominios', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!isManager(req)) return forbidden(res);
    const parsed = z.object({name:z.string().min(2),document:z.string().optional().nullable(),city:z.string().optional().nullable(),state:z.string().max(2).optional().nullable()}).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({error:'Dados do condomínio inválidos'});
    const r=await pool.query('INSERT INTO condominiums(name,document,city,state) VALUES($1,$2,$3,$4) RETURNING *',[parsed.data.name,parsed.data.document||null,parsed.data.city||null,parsed.data.state?.toUpperCase()||null]);
    if (!isSuper(req)) await pool.query('INSERT INTO user_condominiums(user_id,condominium_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.auth!.sub,r.rows[0].id]);
    await audit(req,'create','condominium',r.rows[0].id,parsed.data); res.status(201).json(r.rows[0]);
  });

  app.put('/api/v1/condominios/:id', requireAuth, async (req: AuthenticatedRequest,res)=>{
    if(!isManager(req)||!await canAccessCondo(req,req.params.id)) return forbidden(res);
    const p=z.object({name:z.string().min(2),document:z.string().optional().nullable(),city:z.string().optional().nullable(),state:z.string().max(2).optional().nullable()}).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    const r=await pool.query('UPDATE condominiums SET name=$1,document=$2,city=$3,state=$4 WHERE id=$5 RETURNING *',[p.data.name,p.data.document||null,p.data.city||null,p.data.state?.toUpperCase()||null,req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:'Condomínio não encontrado'}); await audit(req,'update','condominium',req.params.id,p.data); res.json(r.rows[0]);
  });

  app.delete('/api/v1/condominios/:id', requireAuth, async (req: AuthenticatedRequest,res)=>{
    if(!isManager(req)||!await canAccessCondo(req,req.params.id)) return forbidden(res);
    const r=await pool.query('DELETE FROM condominiums WHERE id=$1 RETURNING id',[req.params.id]); if(!r.rowCount)return res.status(404).json({error:'Não encontrado'});
    await audit(req,'delete','condominium',req.params.id); res.status(204).end();
  });

  app.get('/api/v1/blocos', requireAuth, async (req: AuthenticatedRequest,res)=>{
    const condo=typeof req.query.condominium_id==='string'?req.query.condominium_id:null;
    const r=await pool.query(`SELECT b.id,b.name,b.condominium_id,c.name condominium_name,COUNT(DISTINCT u.id)::int units,COUNT(DISTINCT s.id)::int sensors
      FROM buildings b JOIN condominiums c ON c.id=b.condominium_id LEFT JOIN units u ON u.building_id=b.id LEFT JOIN sensors s ON s.unit_id=u.id
      WHERE ($1::uuid IS NULL OR b.condominium_id=$1) AND ($2::boolean OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$3))
      GROUP BY b.id,c.name ORDER BY c.name,b.name`,[condo,isSuper(req),req.auth!.sub]); res.json(r.rows);
  });
  app.post('/api/v1/blocos',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isManager(req))return forbidden(res); const p=z.object({condominium_id:uuid,name:z.string().min(1)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    if(!await canAccessCondo(req,p.data.condominium_id))return forbidden(res); const r=await pool.query('INSERT INTO buildings(condominium_id,name) VALUES($1,$2) RETURNING *',[p.data.condominium_id,p.data.name]); await audit(req,'create','building',r.rows[0].id,p.data); res.status(201).json(r.rows[0]);
  });
  app.put('/api/v1/blocos/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isManager(req))return forbidden(res); const p=z.object({name:z.string().min(1)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    const q=await pool.query('SELECT condominium_id FROM buildings WHERE id=$1',[req.params.id]); if(!q.rowCount)return res.status(404).json({error:'Bloco não encontrado'}); if(!await canAccessCondo(req,q.rows[0].condominium_id))return forbidden(res);
    const r=await pool.query('UPDATE buildings SET name=$1 WHERE id=$2 RETURNING *',[p.data.name,req.params.id]); await audit(req,'update','building',req.params.id,p.data); res.json(r.rows[0]);
  });
  app.delete('/api/v1/blocos/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isManager(req))return forbidden(res);const q=await pool.query('SELECT condominium_id FROM buildings WHERE id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Não encontrado'});if(!await canAccessCondo(req,q.rows[0].condominium_id))return forbidden(res);await pool.query('DELETE FROM buildings WHERE id=$1',[req.params.id]);await audit(req,'delete','building',req.params.id);res.status(204).end();});

  app.get('/api/v1/unidades',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const r=await pool.query(`SELECT u.id,u.identifier,u.resident_name,u.building_id,b.name building_name,c.id condominium_id,c.name condominium_name,s.id sensor_id,s.serial sensor_serial,
      COALESCE((SELECT SUM(tr.consumption_m3) FROM telemetry_readings tr WHERE tr.sensor_id=s.id AND tr.received_at>=date_trunc('month',now())),0)::float8 month_consumption_m3
      FROM units u JOIN buildings b ON b.id=u.building_id JOIN condominiums c ON c.id=b.condominium_id LEFT JOIN sensors s ON s.unit_id=u.id
      WHERE $1::boolean OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2) ORDER BY c.name,b.name,u.identifier`,[isSuper(req),req.auth!.sub]);res.json(r.rows);
  });
  app.post('/api/v1/unidades',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isManager(req))return forbidden(res);const p=z.object({building_id:uuid,identifier:z.string().min(1),resident_name:z.string().optional().nullable()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    const q=await pool.query('SELECT condominium_id FROM buildings WHERE id=$1',[p.data.building_id]);if(!q.rowCount)return res.status(404).json({error:'Bloco não encontrado'});if(!await canAccessCondo(req,q.rows[0].condominium_id))return forbidden(res);
    const r=await pool.query('INSERT INTO units(building_id,identifier,resident_name) VALUES($1,$2,$3) RETURNING *',[p.data.building_id,p.data.identifier,p.data.resident_name||null]);await audit(req,'create','unit',r.rows[0].id,p.data);res.status(201).json(r.rows[0]);
  });
  app.put('/api/v1/unidades/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isManager(req))return forbidden(res);const p=z.object({identifier:z.string().min(1),resident_name:z.string().optional().nullable()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});const q=await pool.query('SELECT b.condominium_id FROM units u JOIN buildings b ON b.id=u.building_id WHERE u.id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Unidade não encontrada'});if(!await canAccessCondo(req,q.rows[0].condominium_id))return forbidden(res);const r=await pool.query('UPDATE units SET identifier=$1,resident_name=$2 WHERE id=$3 RETURNING *',[p.data.identifier,p.data.resident_name||null,req.params.id]);await audit(req,'update','unit',req.params.id,p.data);res.json(r.rows[0]);});
  app.delete('/api/v1/unidades/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isManager(req))return forbidden(res);const q=await pool.query('SELECT b.condominium_id FROM units u JOIN buildings b ON b.id=u.building_id WHERE u.id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Não encontrado'});if(!await canAccessCondo(req,q.rows[0].condominium_id))return forbidden(res);await pool.query('DELETE FROM units WHERE id=$1',[req.params.id]);await audit(req,'delete','unit',req.params.id);res.status(204).end();});

  app.get('/api/v1/sensores',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const r=await pool.query(`SELECT s.id,s.serial,s.sensor_type,s.central_serial,s.conversion_factor::float8,s.active,s.last_raw_value,s.last_reading_at,s.virtual_counter::float8,s.unit_id,u.identifier unit_identifier,b.name building_name,c.name condominium_name,
      CASE WHEN s.last_reading_at>=now()-interval '10 minutes' THEN 'online' WHEN s.last_reading_at>=now()-interval '30 minutes' THEN 'attention' ELSE 'offline' END connection_status
      FROM sensors s LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN buildings b ON b.id=u.building_id LEFT JOIN condominiums c ON c.id=b.condominium_id
      WHERE $1::boolean OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2) OR (c.id IS NULL AND $1::boolean)
      ORDER BY s.last_reading_at DESC NULLS LAST,s.serial`,[isSuper(req),req.auth!.sub]);res.json(r.rows);
  });
  app.post('/api/v1/sensores',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isManager(req))return forbidden(res);const p=z.object({serial:z.string().min(2),sensor_type:z.string().min(1).default('09'),central_serial:z.string().optional().nullable(),conversion_factor:z.coerce.number().positive().default(1),unit_id:uuid.optional().nullable()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    if(p.data.unit_id){const q=await pool.query('SELECT b.condominium_id FROM units u JOIN buildings b ON b.id=u.building_id WHERE u.id=$1',[p.data.unit_id]);if(!q.rowCount)return res.status(404).json({error:'Unidade não encontrada'});if(!await canAccessCondo(req,q.rows[0].condominium_id))return forbidden(res);}
    const r=await pool.query('INSERT INTO sensors(serial,sensor_type,central_serial,conversion_factor,unit_id) VALUES($1,$2,$3,$4,$5) RETURNING *',[p.data.serial,p.data.sensor_type,p.data.central_serial||null,p.data.conversion_factor,p.data.unit_id||null]);await audit(req,'create','sensor',r.rows[0].id,p.data);res.status(201).json(r.rows[0]);
  });
  app.put('/api/v1/sensores/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isManager(req))return forbidden(res);const p=z.object({serial:z.string().min(2),sensor_type:z.string().min(1),central_serial:z.string().optional().nullable(),conversion_factor:z.coerce.number().positive(),unit_id:uuid.optional().nullable(),active:z.boolean().default(true)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});if(p.data.unit_id){const q=await pool.query('SELECT b.condominium_id FROM units u JOIN buildings b ON b.id=u.building_id WHERE u.id=$1',[p.data.unit_id]);if(!q.rowCount)return res.status(404).json({error:'Unidade não encontrada'});if(!await canAccessCondo(req,q.rows[0].condominium_id))return forbidden(res);}const r=await pool.query('UPDATE sensors SET serial=$1,sensor_type=$2,central_serial=$3,conversion_factor=$4,unit_id=$5,active=$6 WHERE id=$7 RETURNING *',[p.data.serial,p.data.sensor_type,p.data.central_serial||null,p.data.conversion_factor,p.data.unit_id||null,p.data.active,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Sensor não encontrado'});await audit(req,'update','sensor',req.params.id,p.data);res.json(r.rows[0]);});
  app.delete('/api/v1/sensores/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isManager(req))return forbidden(res);const r=await pool.query('DELETE FROM sensors WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Não encontrado'});await audit(req,'delete','sensor',req.params.id);res.status(204).end();});

  app.get('/api/v1/telemetria/historico',requireAuth,async(req:AuthenticatedRequest,res)=>{const sensorId=typeof req.query.sensor_id==='string'?req.query.sensor_id:'';if(!uuid.safeParse(sensorId).success)return res.status(400).json({error:'sensor_id inválido'});const limit=Math.min(1000,Math.max(1,Number(req.query.limit??200)));const r=await pool.query(`SELECT tr.id,tr.raw_value,tr.delta_raw,tr.consumption_m3::float8,tr.virtual_counter::float8,tr.received_at,tr.source_timestamp,tr.status,tr.offline_seconds FROM telemetry_readings tr JOIN sensors s ON s.id=tr.sensor_id LEFT JOIN units u ON u.id=s.unit_id LEFT JOIN buildings b ON b.id=u.building_id LEFT JOIN condominiums c ON c.id=b.condominium_id WHERE tr.sensor_id=$1 AND ($2::boolean OR c.id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$3)) ORDER BY tr.received_at DESC LIMIT $4`,[sensorId,isSuper(req),req.auth!.sub,limit]);res.json(r.rows);});

  app.get('/api/v1/alertas',requireAuth,async(req:AuthenticatedRequest,res)=>{const r=await pool.query(`SELECT a.*,c.name condominium_name FROM alert_rules a JOIN condominiums c ON c.id=a.condominium_id WHERE $1::boolean OR a.condominium_id IN(SELECT condominium_id FROM user_condominiums WHERE user_id=$2) ORDER BY c.name,a.type`,[isSuper(req),req.auth!.sub]);res.json(r.rows);});
  app.post('/api/v1/alertas',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isManager(req))return forbidden(res);const p=z.object({condominium_id:uuid,type:z.string().min(2),enabled:z.boolean().default(true),config:z.record(z.string(),z.unknown()).default({})}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});if(!await canAccessCondo(req,p.data.condominium_id))return forbidden(res);const r=await pool.query('INSERT INTO alert_rules(condominium_id,type,enabled,config) VALUES($1,$2,$3,$4) RETURNING *',[p.data.condominium_id,p.data.type,p.data.enabled,JSON.stringify(p.data.config)]);await audit(req,'create','alert_rule',r.rows[0].id,p.data);res.status(201).json(r.rows[0]);});
  app.delete('/api/v1/alertas/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isManager(req))return forbidden(res);const r=await pool.query('DELETE FROM alert_rules WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Não encontrado'});await audit(req,'delete','alert_rule',req.params.id);res.status(204).end();});

  app.get('/api/v1/usuarios',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isSuper(req))return forbidden(res);const r=await pool.query(`SELECT u.id,u.name,u.email,u.role,u.active,u.created_at,COALESCE(json_agg(json_build_object('id',c.id,'name',c.name)) FILTER(WHERE c.id IS NOT NULL),'[]') condominiums FROM users u LEFT JOIN user_condominiums uc ON uc.user_id=u.id LEFT JOIN condominiums c ON c.id=uc.condominium_id GROUP BY u.id ORDER BY u.name`);res.json(r.rows);});
  app.post('/api/v1/usuarios',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isSuper(req))return forbidden(res);const p=z.object({name:z.string().min(2),email:z.string().email(),password:z.string().min(8),role:roleSchema,condominium_ids:z.array(uuid).default([])}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});const client=await pool.connect();try{await client.query('BEGIN');const hash=await bcrypt.hash(p.data.password,10);const r=await client.query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role,active',[p.data.name,p.data.email,hash,p.data.role]);for(const cid of p.data.condominium_ids)await client.query('INSERT INTO user_condominiums(user_id,condominium_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.rows[0].id,cid]);await client.query('COMMIT');await audit(req,'create','user',r.rows[0].id,{name:p.data.name,email:p.data.email,role:p.data.role});res.status(201).json(r.rows[0]);}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}});
  app.patch('/api/v1/usuarios/:id/status',requireAuth,async(req:AuthenticatedRequest,res)=>{if(!isSuper(req))return forbidden(res);const p=z.object({active:z.boolean()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});if(req.params.id===req.auth!.sub&&!p.data.active)return res.status(400).json({error:'Você não pode desativar seu próprio usuário'});const r=await pool.query('UPDATE users SET active=$1 WHERE id=$2 RETURNING id,name,email,role,active',[p.data.active,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Usuário não encontrado'});await audit(req,'status','user',req.params.id,p.data);res.json(r.rows[0]);});
  app.post('/api/v1/me/password',requireAuth,async(req:AuthenticatedRequest,res)=>{const p=z.object({current_password:z.string().min(1),new_password:z.string().min(8)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Senha nova deve ter pelo menos 8 caracteres'});const q=await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.auth!.sub]);if(!q.rowCount||!await bcrypt.compare(p.data.current_password,q.rows[0].password_hash))return res.status(400).json({error:'Senha atual incorreta'});const hash=await bcrypt.hash(p.data.new_password,10);await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,req.auth!.sub]);await audit(req,'password_change','user',req.auth!.sub);res.json({ok:true});});
}
