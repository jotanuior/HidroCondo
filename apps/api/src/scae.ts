import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';

const sensorSchema = z.object({ serial:z.string().min(3).max(100), type:z.string().min(1).max(20), central_serial:z.string().max(200).nullable().optional(), last_seen_at:z.string().datetime({offset:true}).nullable().optional() });
const syncSchema = z.object({ source:z.string().default('SCAE'), generated_at:z.string().datetime({offset:true}), sensor_count:z.number().int().nonnegative().optional(), sensors:z.array(sensorSchema).max(100000) });

const condoSchema=z.object({ scae_condominium_id:z.coerce.number().int().positive(), name:z.string().trim().min(1).max(200), permission:z.enum(['ADMIN','CONVIDADO']) });
const userSchema=z.object({ scae_user_id:z.coerce.number().int().positive(), name:z.string().trim().min(2).max(200), email:z.string().email(), cpf_cnpj:z.string().trim().max(30).nullable().optional(), phone:z.string().trim().max(40).nullable().optional(), scae_role:z.string().max(40).nullable().optional(), registration_status:z.string().max(40).default('COMPLETO'), condominiums:z.array(condoSchema).max(1000).default([]) });
const usersSyncSchema=z.object({ source:z.literal('SCAE').default('SCAE'), generated_at:z.string().datetime({offset:true}), users:z.array(userSchema).max(100000) });

const structureSchema=z.object({
  source:z.literal('SCAE').default('SCAE'), generated_at:z.string().datetime({offset:true}),
  installation_points:z.array(z.object({ scae_installation_point_id:z.coerce.number().int().positive(), scae_condominium_id:z.coerce.number().int().positive(), description:z.string().trim().min(1).max(200) })).max(100000).default([]),
  sensors:z.array(z.object({ scae_sensor_id:z.coerce.number().int().positive(), serial:z.string().trim().min(3).max(100), sensor_type:z.string().trim().min(1).max(40), scae_condominium_id:z.coerce.number().int().positive(), scae_equipment_id:z.coerce.number().int().positive().nullable().optional(), scae_installation_point_id:z.coerce.number().int().positive().nullable().optional(), central_serial:z.string().trim().max(200).nullable().optional() })).max(100000).default([])
});

function validSyncKey(req:any) { const expected=process.env.SCAE_SYNC_API_KEY; const supplied=req.header('x-scae-key'); return Boolean(expected&&supplied&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))); }
function normalizeCpf(v?:string|null){ return v?.replace(/\D/g,'')||null; }

export function registerScaeRoutes(app: Express) {
  app.post('/api/v1/scae/usuarios/sync', async(req,res)=>{
    if(!validSyncKey(req)) return res.status(401).json({ok:false,error:'Chave de sincronização SCAE inválida'});
    const parsed=usersSyncSchema.safeParse(req.body); if(!parsed.success) return res.status(400).json({ok:false,error:'Payload de usuários SCAE inválido',details:parsed.error.flatten()});
    const client=await pool.connect(); let created=0,updated=0,merged=0,conflicts=0;
    try { await client.query('BEGIN');
      for(const incoming of parsed.data.users){
        if(incoming.registration_status!=='COMPLETO') continue;
        const email=incoming.email.trim().toLowerCase(); const cpf=normalizeCpf(incoming.cpf_cnpj);
        let q=await client.query('SELECT * FROM users WHERE scae_user_id=$1 FOR UPDATE',[incoming.scae_user_id]); let user=q.rows[0];
        if(!user){ q=await client.query('SELECT * FROM users WHERE lower(email)=lower($1) FOR UPDATE',[email]); user=q.rows[0]; if(user) merged++; }
        if(!user && cpf){ const cq=await client.query("SELECT * FROM users WHERE regexp_replace(COALESCE(cpf_cnpj,''),'\\D','','g')=$1 FOR UPDATE",[cpf]); if(cq.rowCount===1){ user=cq.rows[0]; merged++; } else if((cq.rowCount??0)>1){ conflicts++; continue; } }
        const hasAdmin=incoming.condominiums.some(c=>c.permission==='ADMIN');
        if(user){ await client.query(`UPDATE users SET name=$2,email=$3,phone=COALESCE($4,phone),cpf_cnpj=COALESCE($5,cpf_cnpj),scae_user_id=$6,source=CASE WHEN source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE 'SCAE' END,scae_role=$7,scae_registration_status=$8,scae_synced_at=now(),active=true WHERE id=$1`,[user.id,incoming.name,email,incoming.phone||null,cpf,incoming.scae_user_id,incoming.scae_role||null,incoming.registration_status]); updated++; }
        else { const random=crypto.randomBytes(48).toString('base64url'); const hash=await bcrypt.hash(random,12); q=await client.query(`INSERT INTO users(name,email,password_hash,role,phone,cpf_cnpj,scae_user_id,source,scae_role,scae_registration_status,scae_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,'SCAE',$8,$9,now()) RETURNING *`,[incoming.name,email,hash,hasAdmin?'admin':'morador',incoming.phone||null,cpf,incoming.scae_user_id,incoming.scae_role||null,incoming.registration_status]); user=q.rows[0]; created++; }
        for(const c of incoming.condominiums){
          let cq=await client.query('SELECT * FROM condominiums WHERE scae_condominium_id=$1 FOR UPDATE',[c.scae_condominium_id]); let condo=cq.rows[0];
          if(!condo){ const account=await client.query(`INSERT INTO customer_accounts(name,owner_user_id) VALUES($1,$2) RETURNING id`,[c.name,c.permission==='ADMIN'?user.id:null]); cq=await client.query(`INSERT INTO condominiums(name,account_id,scae_condominium_id,source,scae_synced_at) VALUES($1,$2,$3,'SCAE',now()) RETURNING *`,[c.name,account.rows[0].id,c.scae_condominium_id]); condo=cq.rows[0]; }
          else await client.query(`UPDATE condominiums SET name=$2,source=CASE WHEN source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE 'SCAE' END,scae_synced_at=now() WHERE id=$1`,[condo.id,c.name]);
          const role=c.permission==='ADMIN'?'admin':'morador'; await client.query('INSERT INTO user_condominiums(user_id,condominium_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,condo.id]); await client.query(`INSERT INTO access_grants(user_id,scope_type,scope_id,role) VALUES($1,'condominium',$2,$3) ON CONFLICT DO NOTHING`,[user.id,condo.id,role]);
          if(condo.account_id) await client.query(`INSERT INTO account_members(account_id,user_id,role,is_owner) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,user_id) DO UPDATE SET role=EXCLUDED.role,is_owner=account_members.is_owner OR EXCLUDED.is_owner`,[condo.account_id,user.id,role,c.permission==='ADMIN']);
        }
      }
      await client.query(`INSERT INTO scae_sync_log(entity_type,received_count,created_count,updated_count,merged_count,conflict_count,generated_at) VALUES('users',$1,$2,$3,$4,$5,$6)`,[parsed.data.users.length,created,updated,merged,conflicts,parsed.data.generated_at]); await client.query('COMMIT'); res.json({ok:true,received:parsed.data.users.length,created,updated,merged,conflicts});
    } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
  });

  app.post('/api/v1/scae/estrutura/sync',async(req,res)=>{
    if(!validSyncKey(req)) return res.status(401).json({ok:false,error:'Chave de sincronização SCAE inválida'}); const parsed=structureSchema.safeParse(req.body); if(!parsed.success)return res.status(400).json({ok:false,error:'Payload de estrutura SCAE inválido',details:parsed.error.flatten()}); const client=await pool.connect(); let units=0,sensors=0;
    try{await client.query('BEGIN');
      for(const p of parsed.data.installation_points){ const cq=await client.query('SELECT id FROM condominiums WHERE scae_condominium_id=$1',[p.scae_condominium_id]); if(!cq.rowCount)continue; const condoId=cq.rows[0].id; let bq=await client.query("SELECT id FROM buildings WHERE condominium_id=$1 AND name='SCAE' LIMIT 1",[condoId]); if(!bq.rowCount)bq=await client.query("INSERT INTO buildings(condominium_id,name) VALUES($1,'SCAE') RETURNING id",[condoId]); await client.query(`INSERT INTO units(building_id,identifier,scae_installation_point_id,source,scae_synced_at) VALUES($1,$2,$3,'SCAE',now()) ON CONFLICT(scae_installation_point_id) WHERE scae_installation_point_id IS NOT NULL DO UPDATE SET identifier=EXCLUDED.identifier,scae_synced_at=now()`,[bq.rows[0].id,p.description,p.scae_installation_point_id]); units++; }
      for(const s of parsed.data.sensors){ const uq=s.scae_installation_point_id?await client.query('SELECT id FROM units WHERE scae_installation_point_id=$1',[s.scae_installation_point_id]):{rows:[]}; const unitId=uq.rows[0]?.id??null; const cq=await client.query('SELECT account_id FROM condominiums WHERE scae_condominium_id=$1',[s.scae_condominium_id]); if(!cq.rowCount)continue; await client.query(`INSERT INTO sensors(unit_id,serial,sensor_type,central_serial,account_id,scae_sensor_id,scae_equipment_id,source,scae_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,'SCAE',now()) ON CONFLICT(serial) DO UPDATE SET unit_id=COALESCE(EXCLUDED.unit_id,sensors.unit_id),sensor_type=EXCLUDED.sensor_type,central_serial=COALESCE(EXCLUDED.central_serial,sensors.central_serial),account_id=COALESCE(EXCLUDED.account_id,sensors.account_id),scae_sensor_id=EXCLUDED.scae_sensor_id,scae_equipment_id=EXCLUDED.scae_equipment_id,source=CASE WHEN sensors.source='HIDROCONDO' THEN 'HIDROCONDO+SCAE' ELSE 'SCAE' END,scae_synced_at=now()`,[unitId,s.serial,s.sensor_type,s.central_serial||null,cq.rows[0].account_id,s.scae_sensor_id,s.scae_equipment_id||null]); sensors++; }
      await client.query('COMMIT'); res.json({ok:true,units,sensors}); }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });

  app.post('/api/v1/scae/sensores/sync', async (req, res) => {
    if (!validSyncKey(req)) return res.status(401).json({ ok:false,error:'Chave de sincronização SCAE inválida' }); const parsed=syncSchema.safeParse(req.body); if(!parsed.success)return res.status(400).json({ok:false,error:'Payload de sincronização inválido',details:parsed.error.flatten()}); const payload=parsed.data; const list=payload.sensors.filter(s=>s.type==='09'&&s.serial.startsWith('09')); if(payload.sensors.length>0&&list.length===0)return res.status(400).json({ok:false,error:'Nenhum sensor tipo 09 válido recebido'}); const client=await pool.connect(); try{await client.query('BEGIN'); await client.query("UPDATE scae_sensor_inventory SET scae_present=FALSE,updated_at=now() WHERE sensor_type='09'"); let inserted=0,updated=0; for(const s of list){const r=await client.query(`INSERT INTO scae_sensor_inventory(serial,sensor_type,central_serial,first_synced_at,last_synced_at,last_seen_at,scae_present,updated_at) VALUES($1,$2,$3,now(),now(),$4,TRUE,now()) ON CONFLICT(serial) DO UPDATE SET sensor_type=EXCLUDED.sensor_type,central_serial=COALESCE(EXCLUDED.central_serial,scae_sensor_inventory.central_serial),last_synced_at=now(),last_seen_at=COALESCE(EXCLUDED.last_seen_at,scae_sensor_inventory.last_seen_at),scae_present=TRUE,updated_at=now() RETURNING (xmax=0) inserted`,[s.serial.trim(),s.type.trim(),s.central_serial?.trim()||null,s.last_seen_at??null]);if(r.rows[0]?.inserted)inserted++;else updated++;} const a=await client.query("SELECT count(*)::int count FROM scae_sensor_inventory WHERE sensor_type='09' AND scae_present=FALSE");await client.query('COMMIT');return res.json({ok:true,source:payload.source,generated_at:payload.generated_at,received:list.length,inserted,updated,absent:a.rows[0]?.count??0});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
}
