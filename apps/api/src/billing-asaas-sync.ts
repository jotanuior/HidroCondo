import type { Express, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid=z.string().uuid();
const isSuper=(req:AuthenticatedRequest)=>req.auth?.role==='superadmin';
const forbidden=(res:Response)=>res.status(403).json({error:'Somente o superadministrador pode gerenciar o financeiro'});

function asaasConfig(){
  const apiKey=process.env.ASAAS_API_KEY?.trim();
  const baseUrl=(process.env.ASAAS_BASE_URL?.trim()||'https://api-sandbox.asaas.com/v3').replace(/\/$/,'');
  if(!apiKey) throw new Error('ASAAS_API_KEY não configurada');
  return {apiKey,baseUrl};
}

async function asaas(path:string,init:RequestInit={}){
  const {apiKey,baseUrl}=asaasConfig();
  const response=await fetch(`${baseUrl}${path}`,{
    ...init,
    headers:{accept:'application/json','content-type':'application/json',access_token:apiKey,...(init.headers||{})}
  });
  const text=await response.text();
  let body:any={};
  try{body=text?JSON.parse(text):{};}catch{body={raw:text};}
  if(!response.ok){
    const message=body?.errors?.map?.((e:any)=>e.description).filter(Boolean).join('; ')||body?.error||`Asaas HTTP ${response.status}`;
    const err=new Error(message);(err as any).status=response.status;throw err;
  }
  return body;
}

async function loadAccount(id:string){
  const q=await pool.query(`SELECT ca.*,u.name owner_name,u.email owner_email,u.cpf_cnpj owner_document,u.phone owner_phone
    FROM customer_accounts ca LEFT JOIN users u ON u.id=ca.owner_user_id WHERE ca.id=$1`,[id]);
  return q.rows[0]||null;
}

async function reconcileAccount(id:string,overrides:any={}){
  const a=await loadAccount(id);
  if(!a) throw Object.assign(new Error('Cliente não encontrado'),{status:404});
  if(a.asaas_customer_id) return {id:a.asaas_customer_id,existing:true,source:'local'};

  const external=await asaas(`/customers?externalReference=${encodeURIComponent(a.id)}&limit=1`);
  const found=Array.isArray(external?.data)?external.data[0]:null;
  if(found?.id){
    await pool.query(`UPDATE customer_accounts SET asaas_customer_id=$2,billing_status=CASE WHEN billing_status='inactive' THEN 'ready' ELSE billing_status END WHERE id=$1`,[a.id,found.id]);
    return {...found,existing:true,source:'externalReference'};
  }

  const cpfCnpj=String(overrides.cpfCnpj||a.owner_document||'').replace(/\D/g,'');
  if(!cpfCnpj) throw Object.assign(new Error('CPF/CNPJ necessário para cadastrar o cliente no Asaas'),{status:400,code:'MISSING_DOCUMENT'});

  const byDocument=await asaas(`/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}&limit=1`);
  const docFound=Array.isArray(byDocument?.data)?byDocument.data[0]:null;
  if(docFound?.id){
    await pool.query(`UPDATE customer_accounts SET asaas_customer_id=$2,billing_status=CASE WHEN billing_status='inactive' THEN 'ready' ELSE billing_status END WHERE id=$1`,[a.id,docFound.id]);
    return {...docFound,existing:true,source:'cpfCnpj'};
  }

  const body={
    name:overrides.name||a.owner_name||a.name,
    cpfCnpj,
    email:overrides.email||a.owner_email||undefined,
    mobilePhone:overrides.mobilePhone||a.owner_phone||undefined,
    externalReference:a.id,
    notificationDisabled:overrides.notificationDisabled??false
  };
  const remote=await asaas('/customers',{method:'POST',body:JSON.stringify(body)});
  await pool.query(`UPDATE customer_accounts SET asaas_customer_id=$2,billing_status=CASE WHEN billing_status='inactive' THEN 'ready' ELSE billing_status END WHERE id=$1`,[a.id,remote.id]);
  return {...remote,existing:false,source:'created'};
}

export function registerBillingAsaasSyncRoutes(app:Express){
  app.post('/api/v1/financeiro/clientes/:id/asaas/reconciliar',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);
    if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Conta inválida'});
    try{
      const body=z.object({name:z.string().min(2).optional(),cpfCnpj:z.string().optional(),email:z.string().email().optional(),mobilePhone:z.string().optional(),notificationDisabled:z.boolean().optional()}).safeParse(req.body||{});
      if(!body.success)return res.status(400).json({error:'Dados inválidos'});
      const result=await reconcileAccount(req.params.id,body.data);
      res.status(result.existing?200:201).json(result);
    }catch(e:any){res.status(Number(e?.status)||500).json({error:e?.message||'Falha ao sincronizar cliente'});}
  });

  app.post('/api/v1/financeiro/clientes/sincronizar-todos',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);
    const q=await pool.query(`SELECT ca.id,ca.name,u.cpf_cnpj owner_document FROM customer_accounts ca LEFT JOIN users u ON u.id=ca.owner_user_id WHERE ca.asaas_customer_id IS NULL ORDER BY ca.name`);
    const result={total:q.rowCount||0,created:0,linked:0,skipped:0,failed:0,items:[] as any[]};
    for(const row of q.rows){
      if(!String(row.owner_document||'').replace(/\D/g,'')){
        result.skipped++;result.items.push({id:row.id,name:row.name,status:'skipped',reason:'CPF/CNPJ ausente'});continue;
      }
      try{
        const r=await reconcileAccount(row.id);
        if(r.existing)result.linked++;else result.created++;
        result.items.push({id:row.id,name:row.name,status:r.existing?'linked':'created',asaas_customer_id:r.id,source:r.source});
      }catch(e:any){
        result.failed++;result.items.push({id:row.id,name:row.name,status:'failed',reason:e?.message||'Falha'});
      }
    }
    res.json(result);
  });
}
