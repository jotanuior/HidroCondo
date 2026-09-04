import type { Express, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid=z.string().uuid();
const roleSchema=z.enum(['superadmin','admin','sindico','zelador','conselheiro','morador']);
const manageableByAdmin=new Set(['sindico','zelador','conselheiro','morador']);
const forbidden=(res:Response)=>res.status(403).json({error:'Sem permissão para esta operação'});
const isSuper=(req:AuthenticatedRequest)=>req.auth?.role==='superadmin';
const isAdmin=(req:AuthenticatedRequest)=>req.auth?.role==='admin';

async function actorCondoIds(req:AuthenticatedRequest){
  if(isSuper(req))return null;
  const q=await pool.query(`SELECT condominium_id FROM user_condominiums WHERE user_id=$1
    UNION SELECT scope_id FROM access_grants WHERE user_id=$1 AND scope_type='condominium'`,[req.auth!.sub]);
  return q.rows.map(r=>String(r.condominium_id??r.scope_id));
}

async function audit(req:AuthenticatedRequest|undefined,action:string,id:string,payload?:unknown){
  await pool.query('INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5)',[req?.auth?.sub??null,action,'user',id,payload?JSON.stringify(payload):null]);
}

async function canManageUser(req:AuthenticatedRequest,userId:string){
  if(isSuper(req))return true;
  if(!isAdmin(req))return false;
  const target=await pool.query('SELECT role FROM users WHERE id=$1',[userId]);
  if(!target.rowCount||!manageableByAdmin.has(target.rows[0].role))return false;
  const condos=await actorCondoIds(req);
  const q=await pool.query(`SELECT 1 FROM access_grants ag WHERE ag.user_id=$1 AND ag.scope_type='condominium' AND ag.scope_id=ANY($2::uuid[])
    UNION SELECT 1 FROM user_condominiums uc WHERE uc.user_id=$1 AND uc.condominium_id=ANY($2::uuid[]) LIMIT 1`,[userId,condos]);
  return !!q.rowCount;
}

async function replaceCondoAccess(userId:string,role:string,condoIds:string[],actorId:string){
  await pool.query("DELETE FROM access_grants WHERE user_id=$1 AND scope_type='condominium'",[userId]);
  await pool.query('DELETE FROM user_condominiums WHERE user_id=$1',[userId]);
  for(const cid of condoIds){
    await pool.query('INSERT INTO user_condominiums(user_id,condominium_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[userId,cid]);
    await pool.query(`INSERT INTO access_grants(user_id,scope_type,scope_id,role,created_by) VALUES($1,'condominium',$2,$3,$4) ON CONFLICT DO NOTHING`,[userId,cid,role,actorId]);
  }
}

function mailTransport(){
  if(!process.env.SMTP_HOST)return null;
  return nodemailer.createTransport({
    host:process.env.SMTP_HOST,
    port:Number(process.env.SMTP_PORT??587),
    secure:String(process.env.SMTP_SECURE??'false').toLowerCase()==='true',
    auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined
  });
}

async function sendResetMail(email:string,name:string,url:string){
  const transport=mailTransport();
  if(!transport)throw new Error('SMTP não configurado');
  const from=process.env.MAIL_FROM||'HidroCondo <no-reply@localhost>';
  await transport.sendMail({
    from,to:email,subject:'Redefinição de senha · HidroCondo',
    text:`Olá, ${name}.\n\nRecebemos uma solicitação para redefinir sua senha do HidroCondo.\n\nUse este link: ${url}\n\nO link expira em 60 minutos. Se você não solicitou, ignore esta mensagem.`,
    html:`<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2>Redefinição de senha</h2><p>Olá, <strong>${name}</strong>.</p><p>Recebemos uma solicitação para redefinir sua senha do HidroCondo.</p><p><a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Criar nova senha</a></p><p style="color:#64748b;font-size:13px">Este link expira em 60 minutos. Se você não solicitou, ignore esta mensagem.</p></div>`
  });
}

export function registerUserRoutes(app:Express){
  app.get('/api/v1/usuarios',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)&&!isAdmin(req))return forbidden(res);
    const condos=await actorCondoIds(req);
    const params:any[]=[];
    let where='';
    if(!isSuper(req)){params.push(condos);where=`WHERE u.role IN ('sindico','zelador','conselheiro','morador') AND EXISTS(
      SELECT 1 FROM access_grants ag WHERE ag.user_id=u.id AND ag.scope_type='condominium' AND ag.scope_id=ANY($1::uuid[])
      UNION SELECT 1 FROM user_condominiums uc WHERE uc.user_id=u.id AND uc.condominium_id=ANY($1::uuid[])
    )`;}
    const q=await pool.query(`SELECT u.id,u.name,u.email,u.role,u.active,u.created_at,
      COALESCE((SELECT json_agg(DISTINCT jsonb_build_object('id',c.id,'name',c.name)) FROM condominiums c WHERE c.id IN(
        SELECT condominium_id FROM user_condominiums WHERE user_id=u.id
        UNION SELECT scope_id FROM access_grants WHERE user_id=u.id AND scope_type='condominium'
      )),'[]'::json) condominiums
      FROM users u ${where} ORDER BY u.name`,params);
    res.json(q.rows);
  });

  app.post('/api/v1/usuarios',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)&&!isAdmin(req))return forbidden(res);
    const p=z.object({name:z.string().min(2),email:z.string().email(),password:z.string().min(8),role:roleSchema,condominium_ids:z.array(uuid).default([]),active:z.boolean().default(true)}).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    if(isAdmin(req)&&!manageableByAdmin.has(p.data.role))return forbidden(res);
    if(p.data.role==='morador')return res.status(400).json({error:'Morador deve ser vinculado a uma unidade pelo fluxo de convite'});
    const allowed=await actorCondoIds(req);
    if(allowed&&p.data.condominium_ids.some(x=>!allowed.includes(x)))return forbidden(res);
    const hash=await bcrypt.hash(p.data.password,12);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query('INSERT INTO users(name,email,password_hash,role,active) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,active,created_at',[p.data.name,p.data.email.toLowerCase(),hash,p.data.role,p.data.active]);
      await client.query('COMMIT');
      await replaceCondoAccess(r.rows[0].id,p.data.role,p.data.condominium_ids,req.auth!.sub);
      await audit(req,'create',r.rows[0].id,{role:p.data.role,condominium_ids:p.data.condominium_ids});
      res.status(201).json(r.rows[0]);
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  });

  app.put('/api/v1/usuarios/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const id=req.params.id;if(!uuid.safeParse(id).success)return res.status(400).json({error:'ID inválido'});
    if(!await canManageUser(req,id))return forbidden(res);
    const p=z.object({name:z.string().min(2),email:z.string().email(),role:roleSchema,active:z.boolean(),condominium_ids:z.array(uuid).default([])}).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    if(isAdmin(req)&&!manageableByAdmin.has(p.data.role))return forbidden(res);
    const allowed=await actorCondoIds(req);if(allowed&&p.data.condominium_ids.some(x=>!allowed.includes(x)))return forbidden(res);
    const r=await pool.query('UPDATE users SET name=$1,email=$2,role=$3,active=$4 WHERE id=$5 RETURNING id,name,email,role,active,created_at',[p.data.name,p.data.email.toLowerCase(),p.data.role,p.data.active,id]);
    if(!r.rowCount)return res.status(404).json({error:'Usuário não encontrado'});
    await replaceCondoAccess(id,p.data.role,p.data.condominium_ids,req.auth!.sub);
    await audit(req,'update',id,{role:p.data.role,active:p.data.active,condominium_ids:p.data.condominium_ids});
    res.json(r.rows[0]);
  });

  app.patch('/api/v1/usuarios/:id/status',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const id=req.params.id;if(id===req.auth!.sub)return res.status(400).json({error:'Você não pode desativar sua própria conta'});
    if(!await canManageUser(req,id))return forbidden(res);
    const p=z.object({active:z.boolean()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    const r=await pool.query('UPDATE users SET active=$1 WHERE id=$2 RETURNING id,name,email,role,active',[p.data.active,id]);
    await audit(req,p.data.active?'activate':'deactivate',id);res.json(r.rows[0]);
  });

  app.delete('/api/v1/usuarios/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const id=req.params.id;if(id===req.auth!.sub)return res.status(400).json({error:'Você não pode excluir sua própria conta'});
    if(!await canManageUser(req,id))return forbidden(res);
    const r=await pool.query('DELETE FROM users WHERE id=$1 RETURNING id',[id]);
    if(!r.rowCount)return res.status(404).json({error:'Usuário não encontrado'});
    await audit(req,'delete',id);res.status(204).end();
  });

  app.post('/api/v1/usuarios/:id/reset-password',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const id=req.params.id;if(!await canManageUser(req,id))return forbidden(res);
    const p=z.object({password:z.string().min(8)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Senha deve ter no mínimo 8 caracteres'});
    const hash=await bcrypt.hash(p.data.password,12);
    const r=await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id,name,email',[hash,id]);
    if(!r.rowCount)return res.status(404).json({error:'Usuário não encontrado'});
    await pool.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[id]);
    await audit(req,'admin_reset_password',id);res.json({ok:true});
  });

  app.post('/api/v1/auth/forgot-password',async(req,res)=>{
    const p=z.object({email:z.string().email()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'E-mail inválido'});
    const generic={ok:true,message:'Se o e-mail existir, enviaremos as instruções de recuperação.'};
    const q=await pool.query('SELECT id,name,email FROM users WHERE lower(email)=lower($1) AND active=true',[p.data.email]);
    if(!q.rowCount)return res.json(generic);
    const user=q.rows[0],token=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[user.id]);
    await pool.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '60 minutes')",[user.id,hash]);
    const base=(process.env.APP_PUBLIC_URL||'https://hidrocondo.tecmen.com.br').replace(/\/$/,'');
    try{await sendResetMail(user.email,user.name,`${base}/redefinir-senha.html?token=${token}`)}catch(e){console.error('[password-reset] falha no envio',e);return res.status(503).json({error:'Recuperação por e-mail indisponível no momento'});}
    res.json(generic);
  });

  app.post('/api/v1/auth/reset-password',async(req,res)=>{
    const p=z.object({token:z.string().min(40),password:z.string().min(8)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Dados inválidos'});
    const hash=crypto.createHash('sha256').update(p.data.token).digest('hex');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const q=await client.query('SELECT id,user_id FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE',[hash]);
      if(!q.rowCount){await client.query('ROLLBACK');return res.status(400).json({error:'Link inválido ou expirado'});}
      const passwordHash=await bcrypt.hash(p.data.password,12);
      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[passwordHash,q.rows[0].user_id]);
      await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL',[q.rows[0].user_id]);
      await client.query('COMMIT');
      res.json({ok:true});
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  });
}
