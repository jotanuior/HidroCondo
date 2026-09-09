import type {Express} from 'express';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pool} from './db.js';
import {requireAuth,type AuthenticatedRequest} from './auth.js';
import {scopePermission,operationalSensors} from './operation-scope.js';
import {canManageSensor,canManageCondominium} from './sensor-management.js';

const uuid=z.string().uuid();
const reason=z.string().trim().min(3).max(500);
const superUser=(req:AuthenticatedRequest)=>req.auth!.role==='superadmin';
const accountPermission=`($1::boolean OR EXISTS(SELECT 1 FROM account_members m WHERE m.account_id=a.id AND m.user_id=$2 AND m.role='admin')
  OR EXISTS(SELECT 1 FROM access_grants g WHERE g.scope_type='account' AND g.scope_id=a.id AND g.user_id=$2 AND g.role='admin'))`;
async function audit(c:PoolClient,req:AuthenticatedRequest,action:string,type:string,id:string,before:unknown,after:unknown,note:string){
  await c.query(`INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5)`,
    [req.auth!.sub,action,type,id,JSON.stringify({before,after,reason:note})]);
}
async function permittedAccount(req:AuthenticatedRequest,id:string,c:PoolClient){
  if(!['superadmin','admin'].includes(req.auth!.role))return false;
  return (await c.query(`SELECT a.id FROM customer_accounts a WHERE a.id=$3 AND ${accountPermission}`,[superUser(req),req.auth!.sub,id])).rowCount===1;
}
const usersForSensor=`WITH location AS(${operationalSensors}) SELECT DISTINCT usr.id,usr.name,usr.email,usr.role,usr.active
 FROM users usr CROSS JOIN location o WHERE o.sensor_id=$1 AND (
   EXISTS(SELECT 1 FROM account_members m WHERE m.user_id=usr.id AND m.account_id=o.account_id)
   OR EXISTS(SELECT 1 FROM user_condominiums uc WHERE uc.user_id=usr.id AND uc.condominium_id=o.condominium_id)
   OR EXISTS(SELECT 1 FROM access_grants g WHERE g.user_id=usr.id AND (
     (g.scope_type='account' AND g.scope_id=o.account_id) OR (g.scope_type='condominium' AND g.scope_id=o.condominium_id)
     OR (g.scope_type='building' AND g.scope_id=o.building_id) OR (g.scope_type='unit' AND g.scope_id=o.unit_id)
     OR (g.scope_type='sensor' AND g.scope_id=o.sensor_id))))`;

export function registerSensorDossier(app:Express){
  app.get('/api/v1/gestao/contas',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!['superadmin','admin'].includes(req.auth!.role))return res.status(403).json({error:'Sem permissão'});
    const q=await pool.query(`SELECT a.id,a.name,a.owner_user_id,u.name owner_name FROM customer_accounts a
      LEFT JOIN users u ON u.id=a.owner_user_id WHERE ${accountPermission} ORDER BY a.name`,[superUser(req),req.auth!.sub]);res.json(q.rows);
  });
  app.get('/api/v1/gestao/contas/:id/membros',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Conta inválida'});
    const c=await pool.connect();try{
      if(!await permittedAccount(req,String(req.params.id),c))return res.status(403).json({error:'Sem permissão para gerenciar esta conta'});
      res.json((await c.query(`SELECT u.id,u.name,u.email,u.active,u.role,m.role account_role,m.is_owner FROM account_members m JOIN users u ON u.id=m.user_id WHERE m.account_id=$1 ORDER BY u.name`,[req.params.id])).rows);
    }finally{c.release()}
  });
  app.post('/api/v1/gestao/contas/:id/proprietario',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const p=z.object({user_id:uuid,expected_owner_id:uuid.nullable(),reason}).safeParse(req.body);
    if(!p.success||!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Informe proprietário e justificativa'});
    const c=await pool.connect();try{
      await c.query('BEGIN');
      const q=await c.query('SELECT * FROM customer_accounts WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!q.rowCount||!await permittedAccount(req,String(req.params.id),c)){await c.query('ROLLBACK');return res.status(403).json({error:'Sem permissão para gerenciar esta conta'})}
      const old=q.rows[0];if(old.owner_user_id!==p.data.expected_owner_id){await c.query('ROLLBACK');return res.status(409).json({error:'O proprietário mudou. Atualize a ficha antes de continuar'})}
      const member=await c.query(`SELECT u.id FROM account_members m JOIN users u ON u.id=m.user_id WHERE m.account_id=$1 AND m.user_id=$2 AND u.active AND u.role IN ('admin','superadmin') FOR UPDATE OF m,u`,[req.params.id,p.data.user_id]);
      if(!member.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Selecione um administrador ativo que já seja membro da conta'})}
      if(old.owner_user_id===p.data.user_id){await c.query('COMMIT');return res.json({ok:true})}
      await c.query('UPDATE account_members SET is_owner=false WHERE account_id=$1',[req.params.id]);
      await c.query(`UPDATE account_members SET is_owner=true,role='admin' WHERE account_id=$1 AND user_id=$2`,[req.params.id,p.data.user_id]);
      await c.query('UPDATE customer_accounts SET owner_user_id=$2 WHERE id=$1',[req.params.id,p.data.user_id]);
      await audit(c,req,'account_owner_changed','account',String(req.params.id),{owner_user_id:old.owner_user_id},{owner_user_id:p.data.user_id},p.data.reason);
      await c.query('COMMIT');res.json({ok:true});
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  });
  app.get('/api/v1/sensores/:id/ficha',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Sensor inválido'});
    const q=await pool.query(`WITH location AS(${operationalSensors}) SELECT o.*,s.sensor_type,s.central_serial,s.conversion_factor,
      s.counter_digits,s.max_flow_m3_hour,s.last_raw_value,s.responsible_user_id,s.ownership_started_at,
      u.resident_name,a.name account_name,a.owner_user_id,owner.name owner_name,resp.name responsible_name,
      claimer.name claimed_by_name
      FROM location o JOIN sensors s ON s.id=o.sensor_id LEFT JOIN units u ON u.id=o.unit_id
      LEFT JOIN customer_accounts a ON a.id=o.account_id LEFT JOIN users owner ON owner.id=a.owner_user_id
      LEFT JOIN users resp ON resp.id=s.responsible_user_id LEFT JOIN users claimer ON claimer.id=s.claimed_by
      WHERE o.sensor_id=$4 AND ${scopePermission('o')}`,[superUser(req),req.auth!.sub,null,req.params.id]);
    if(!q.rowCount)return res.status(403).json({error:'Sem acesso a este sensor'});
    const canManage=await canManageSensor(req,String(req.params.id)),sensor=q.rows[0];
    const users=canManage?(await pool.query(usersForSensor+' ORDER BY usr.name',[req.params.id])).rows:[];
    const canUnit=!!sensor.condominium_id&&await canManageCondominium(req,sensor.condominium_id);
    const c=await pool.connect();let canOwner=false;try{canOwner=!!sensor.account_id&&await permittedAccount(req,sensor.account_id,c)}finally{c.release()}
    const logs=canManage?(await pool.query(`SELECT id,created_at,action,actor_name,actor_role,payload FROM audit_log
      WHERE ((entity_type='sensor' AND entity_id=$1) OR ($4::boolean AND entity_type='account' AND entity_id=$5)) AND ($2::boolean OR created_at>=COALESCE($3::timestamptz,'-infinity'))
      ORDER BY created_at DESC,id DESC LIMIT 100`,[req.params.id,superUser(req),sensor.ownership_started_at,canOwner,sensor.account_id])).rows:[];
    res.json({sensor,users,audit:logs,permissions:{manage:canManage,transfer_account:superUser(req),change_owner:canOwner,manage_unit:canUnit}});
  });
  app.post('/api/v1/sensores/:id/responsavel-unidade',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const p=z.object({name:z.string().trim().max(150),reason}).safeParse(req.body);
    if(!p.success||!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Dados inválidos'});
    const c=await pool.connect();try{
      await c.query('BEGIN');await c.query('SELECT id FROM sensors WHERE id=$1 FOR UPDATE',[req.params.id]);
      const q=await c.query(`SELECT u.id,u.resident_name,b.condominium_id FROM sensors s JOIN units u ON u.id=s.unit_id JOIN buildings b ON b.id=u.building_id WHERE s.id=$1 FOR UPDATE OF u`,[req.params.id]);
      if(!q.rowCount||!await canManageCondominium(req,q.rows[0].condominium_id)){await c.query('ROLLBACK');return res.status(403).json({error:'Sem permissão para alterar a unidade'})}
      await c.query('UPDATE units SET resident_name=$2 WHERE id=$1',[q.rows[0].id,p.data.name||null]);
      await audit(c,req,'unit_responsible_changed','sensor',String(req.params.id),q.rows[0],{unit_id:q.rows[0].id,resident_name:p.data.name||null},p.data.reason);
      await c.query('COMMIT');res.json({ok:true});
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  });
  app.post('/api/v1/gestao/condominios/:id/conta',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!superUser(req))return res.status(403).json({error:'Exige Super Admin'});
    const p=z.object({account_id:uuid,reason}).safeParse(req.body);
    if(!p.success||!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Dados inválidos'});
    const c=await pool.connect();try{
      await c.query('BEGIN');const q=await c.query('SELECT id,account_id FROM condominiums WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Condomínio não encontrado'})}
      if(q.rows[0].account_id){await c.query('ROLLBACK');return res.status(409).json({error:'O condomínio já possui conta. Esta ação regulariza apenas condomínios sem conta'})}
      if(!(await c.query('SELECT id FROM customer_accounts WHERE id=$1 FOR KEY SHARE',[p.data.account_id])).rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Conta inexistente'})}
      const incompatible=await c.query(`SELECT s.id FROM sensors s JOIN units u ON u.id=s.unit_id JOIN buildings b ON b.id=u.building_id WHERE b.condominium_id=$1 AND s.account_id IS DISTINCT FROM $2::uuid`,[req.params.id,p.data.account_id]);
      if(incompatible.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'Existem sensores vinculados sem conta ou em outra conta. Regularize suas fichas primeiro'})}
      await c.query('UPDATE condominiums SET account_id=$2 WHERE id=$1',[req.params.id,p.data.account_id]);
      await audit(c,req,'condominium_account_assigned','condominium',String(req.params.id),q.rows[0],{account_id:p.data.account_id},p.data.reason);
      await c.query('COMMIT');res.json({ok:true});
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  });
  app.post('/api/v1/sensores/:id/responsavel',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const p=z.object({user_id:uuid.nullable(),reason}).safeParse(req.body);
    if(!p.success||!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Informe responsável e justificativa'});
    const c=await pool.connect();try{
      await c.query('BEGIN');const q=await c.query('SELECT responsible_user_id FROM sensors WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!q.rowCount||!await canManageSensor(req,String(req.params.id))){await c.query('ROLLBACK');return res.status(403).json({error:'Sem permissão para este sensor'})}
      if(p.data.user_id){const users=await c.query(usersForSensor+' AND usr.id=$2 AND usr.active',[req.params.id,p.data.user_id]);
        if(!users.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'O responsável precisa estar ativo e já ter acesso ao sensor'})}}
      await c.query('UPDATE sensors SET responsible_user_id=$2 WHERE id=$1',[req.params.id,p.data.user_id]);
      await audit(c,req,'sensor_responsible_changed','sensor',String(req.params.id),q.rows[0],{responsible_user_id:p.data.user_id},p.data.reason);
      await c.query('COMMIT');res.json({ok:true});
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  });
  app.post('/api/v1/sensores/:id/conta',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!superUser(req))return res.status(403).json({error:'A transferência entre contas exige Super Admin'});
    const p=z.object({account_id:uuid,expected_account_id:uuid.nullable(),reason}).safeParse(req.body);
    if(!p.success||!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Informe conta de destino e justificativa'});
    const c=await pool.connect();try{
      await c.query('BEGIN');const q=await c.query('SELECT id,account_id,unit_id,responsible_user_id FROM sensors WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!q.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Sensor não encontrado'})}
      const old=q.rows[0];if(old.account_id!==p.data.expected_account_id){await c.query('ROLLBACK');return res.status(409).json({error:'O vínculo mudou. Atualize a ficha antes de continuar'})}
      if(!(await c.query('SELECT id FROM customer_accounts WHERE id=$1 FOR KEY SHARE',[p.data.account_id])).rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'Conta não encontrada'})}
      if(old.account_id===p.data.account_id){await c.query('COMMIT');return res.json({ok:true})}
      const boundary=(await c.query('SELECT clock_timestamp() AS transfer_at')).rows[0].transfer_at;
      await c.query('UPDATE sensor_installations SET removed_at=$2,removed_by=$3 WHERE sensor_id=$1 AND removed_at IS NULL',[req.params.id,boundary,req.auth!.sub]);
      await c.query(`UPDATE access_invitations SET revoked_at=$2 WHERE scope_type='sensor' AND scope_id=$1 AND revoked_at IS NULL AND used_at IS NULL`,[req.params.id,boundary]);
      const revoked=await c.query(`DELETE FROM access_grants WHERE scope_type='sensor' AND scope_id=$1 RETURNING user_id,role`,[req.params.id]);
      await c.query(`UPDATE sensors SET account_id=$2,unit_id=NULL,responsible_user_id=NULL,ownership_started_at=$3,
        claimed_at=COALESCE(claimed_at,$3),claimed_by=COALESCE(claimed_by,$4) WHERE id=$1`,[req.params.id,p.data.account_id,boundary,req.auth!.sub]);
      await audit(c,req,'sensor_account_transferred','sensor',String(req.params.id),{...old,revoked_grants:revoked.rows},{account_id:p.data.account_id,unit_id:null,responsible_user_id:null},p.data.reason);
      await c.query('COMMIT');res.json({ok:true});
    }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  });
}
