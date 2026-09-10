import type { Express, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid=z.string().uuid();
const isSuper=(req:AuthenticatedRequest)=>req.auth?.role==='superadmin';
const forbidden=(res:Response)=>res.status(403).json({error:'Somente o superadministrador pode gerenciar o financeiro'});
const planType=z.enum(['ONE_TIME','MONTHLY','QUARTERLY','SEMIANNUALLY','YEARLY','CUSTOM']);
const pricingModel=z.enum(['FIXED','PER_ACTIVE_SENSOR','TIERED']);
const paymentMethod=z.enum(['BOLETO','CREDIT_CARD','PIX','UNDEFINED']);

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

async function audit(req:AuthenticatedRequest,action:string,entityType:string,entityId:string,payload?:unknown){
  await pool.query('INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,$2,$3,$4,$5)',[
    req.auth?.sub??null,action,entityType,entityId,payload===undefined?null:JSON.stringify(payload)
  ]);
}

async function resolvePlanAmount(planId:string,accountId:string,customAmount?:number|null){
  if(customAmount!==undefined&&customAmount!==null) return Number(customAmount.toFixed(2));
  const q=await pool.query('SELECT * FROM billing_plans WHERE id=$1 AND active=true',[planId]);
  if(!q.rowCount) throw new Error('Plano não encontrado ou inativo');
  const p=q.rows[0];
  if(p.pricing_model==='FIXED') return Number(p.amount);
  const c=await pool.query('SELECT COUNT(*)::int total FROM sensors WHERE account_id=$1 AND active=true',[accountId]);
  const qty=Number(c.rows[0]?.total||0);
  if(p.pricing_model==='PER_ACTIVE_SENSOR') return Number((Number(p.amount)+qty*Number(p.unit_amount||0)).toFixed(2));
  const tier=await pool.query(`SELECT amount FROM billing_plan_tiers WHERE plan_id=$1 AND min_units<=$2 AND (max_units IS NULL OR max_units>=$2) ORDER BY min_units DESC LIMIT 1`,[planId,qty]);
  if(!tier.rowCount) throw new Error(`Plano sem faixa configurada para ${qty} sensores ativos`);
  return Number(tier.rows[0].amount);
}

function applyDiscount(amount:number,type?:string|null,value?:number|null){
  if(!type||!value) return amount;
  const result=type==='PERCENT'?amount*(1-Math.min(100,value)/100):amount-value;
  return Number(Math.max(0,result).toFixed(2));
}

function cycleFor(type:string){
  const map:Record<string,string>={MONTHLY:'MONTHLY',QUARTERLY:'QUARTERLY',SEMIANNUALLY:'SEMIANNUALLY',YEARLY:'YEARLY'};
  return map[type]||null;
}

function secureEqual(a:string,b:string){
  const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);
}

export function registerBillingRoutes(app:Express){
  app.get('/api/v1/financeiro/configuracao',requireAuth,(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);
    res.json({asaas_configured:Boolean(process.env.ASAAS_API_KEY),environment:(process.env.ASAAS_BASE_URL||'').includes('api.asaas.com')?'production':'sandbox',webhook_configured:Boolean(process.env.ASAAS_WEBHOOK_TOKEN)});
  });

  app.get('/api/v1/financeiro/planos',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);
    const r=await pool.query(`SELECT p.*,COALESCE(json_agg(json_build_object('id',t.id,'min_units',t.min_units,'max_units',t.max_units,'amount',t.amount) ORDER BY t.min_units) FILTER(WHERE t.id IS NOT NULL),'[]') tiers FROM billing_plans p LEFT JOIN billing_plan_tiers t ON t.plan_id=p.id GROUP BY p.id ORDER BY p.active DESC,p.name`);
    res.json(r.rows);
  });

  app.post('/api/v1/financeiro/planos',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);
    const p=z.object({name:z.string().min(2),description:z.string().optional().nullable(),billing_type:planType,pricing_model:pricingModel.default('FIXED'),amount:z.coerce.number().min(0),unit_amount:z.coerce.number().min(0).optional().nullable(),tiers:z.array(z.object({min_units:z.coerce.number().int().min(0),max_units:z.coerce.number().int().min(0).optional().nullable(),amount:z.coerce.number().min(0)})).default([])}).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'Dados do plano inválidos',details:p.error.flatten()});
    const client=await pool.connect();
    try{await client.query('BEGIN');
      const r=await client.query(`INSERT INTO billing_plans(name,description,billing_type,pricing_model,amount,unit_amount) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[p.data.name,p.data.description||null,p.data.billing_type,p.data.pricing_model,p.data.amount,p.data.unit_amount??null]);
      for(const t of p.data.tiers)await client.query('INSERT INTO billing_plan_tiers(plan_id,min_units,max_units,amount) VALUES($1,$2,$3,$4)',[r.rows[0].id,t.min_units,t.max_units??null,t.amount]);
      await client.query('COMMIT');await audit(req,'create','billing_plan',r.rows[0].id,p.data);res.status(201).json(r.rows[0]);
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });

  app.put('/api/v1/financeiro/planos/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Plano inválido'});
    const p=z.object({name:z.string().min(2),description:z.string().optional().nullable(),billing_type:planType,pricing_model:pricingModel,amount:z.coerce.number().min(0),unit_amount:z.coerce.number().min(0).optional().nullable(),active:z.boolean(),tiers:z.array(z.object({min_units:z.coerce.number().int().min(0),max_units:z.coerce.number().int().min(0).optional().nullable(),amount:z.coerce.number().min(0)})).default([])}).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'Dados do plano inválidos',details:p.error.flatten()});
    const client=await pool.connect();
    try{await client.query('BEGIN');const r=await client.query(`UPDATE billing_plans SET name=$2,description=$3,billing_type=$4,pricing_model=$5,amount=$6,unit_amount=$7,active=$8,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,p.data.name,p.data.description||null,p.data.billing_type,p.data.pricing_model,p.data.amount,p.data.unit_amount??null,p.data.active]);
      if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Plano não encontrado'});}await client.query('DELETE FROM billing_plan_tiers WHERE plan_id=$1',[req.params.id]);for(const t of p.data.tiers)await client.query('INSERT INTO billing_plan_tiers(plan_id,min_units,max_units,amount) VALUES($1,$2,$3,$4)',[req.params.id,t.min_units,t.max_units??null,t.amount]);await client.query('COMMIT');await audit(req,'update','billing_plan',req.params.id,p.data);res.json(r.rows[0]);
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });

  app.get('/api/v1/financeiro/clientes',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);
    const r=await pool.query(`SELECT ca.id,ca.name,ca.asaas_customer_id,ca.billing_status,ca.billing_notes,ca.owner_user_id,u.name owner_name,u.email owner_email,u.cpf_cnpj owner_document,u.phone owner_phone,COUNT(DISTINCT s.id) FILTER(WHERE s.active=true)::int active_sensors,bs.id subscription_id,bp.name plan_name,bs.status subscription_status,bs.custom_amount FROM customer_accounts ca LEFT JOIN users u ON u.id=ca.owner_user_id LEFT JOIN sensors s ON s.account_id=ca.id LEFT JOIN LATERAL (SELECT * FROM billing_subscriptions x WHERE x.account_id=ca.id AND x.status IN('draft','active','overdue','paused') ORDER BY x.created_at DESC LIMIT 1) bs ON true LEFT JOIN billing_plans bp ON bp.id=bs.plan_id GROUP BY ca.id,u.id,bs.id,bp.name ORDER BY ca.name`);res.json(r.rows);
  });

  app.post('/api/v1/financeiro/clientes/:id/asaas',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Conta inválida'});
    const account=await pool.query(`SELECT ca.*,u.name owner_name,u.email owner_email,u.cpf_cnpj owner_document,u.phone owner_phone FROM customer_accounts ca LEFT JOIN users u ON u.id=ca.owner_user_id WHERE ca.id=$1`,[req.params.id]);
    if(!account.rowCount)return res.status(404).json({error:'Cliente não encontrado'});if(account.rows[0].asaas_customer_id)return res.json({id:account.rows[0].asaas_customer_id,existing:true});
    const p=z.object({name:z.string().min(2).optional(),cpfCnpj:z.string().min(11).optional(),email:z.string().email().optional(),mobilePhone:z.string().optional(),notificationDisabled:z.boolean().optional()}).safeParse(req.body||{});if(!p.success)return res.status(400).json({error:'Dados do cliente inválidos'});
    const a=account.rows[0];const body={name:p.data.name||a.owner_name||a.name,cpfCnpj:p.data.cpfCnpj||a.owner_document||undefined,email:p.data.email||a.owner_email||undefined,mobilePhone:p.data.mobilePhone||a.owner_phone||undefined,externalReference:a.id,notificationDisabled:p.data.notificationDisabled??false};
    if(!body.cpfCnpj)return res.status(400).json({error:'CPF/CNPJ necessário para cadastrar o cliente no Asaas'});
    const remote=await asaas('/customers',{method:'POST',body:JSON.stringify(body)});await pool.query(`UPDATE customer_accounts SET asaas_customer_id=$2,billing_status=CASE WHEN billing_status='inactive' THEN 'ready' ELSE billing_status END WHERE id=$1`,[a.id,remote.id]);await audit(req,'asaas_customer_create','customer_account',a.id,{asaas_customer_id:remote.id});res.status(201).json(remote);
  });

  app.post('/api/v1/financeiro/assinaturas',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);
    const p=z.object({account_id:uuid,plan_id:uuid,payment_method:paymentMethod.default('UNDEFINED'),start_date:z.string().date(),due_day:z.coerce.number().int().min(1).max(31).optional(),custom_amount:z.coerce.number().min(0).optional().nullable(),discount_type:z.enum(['PERCENT','FIXED']).optional().nullable(),discount_value:z.coerce.number().min(0).optional().nullable(),discount_until:z.string().date().optional().nullable(),grace_days:z.coerce.number().int().min(0).default(0),suspend_after_days:z.coerce.number().int().min(0).optional().nullable(),sync_asaas:z.boolean().default(true)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Assinatura inválida',details:p.error.flatten()});
    const account=await pool.query('SELECT * FROM customer_accounts WHERE id=$1',[p.data.account_id]);if(!account.rowCount)return res.status(404).json({error:'Cliente não encontrado'});
    const plan=await pool.query('SELECT * FROM billing_plans WHERE id=$1 AND active=true',[p.data.plan_id]);if(!plan.rowCount)return res.status(404).json({error:'Plano não encontrado'});
    let amount=await resolvePlanAmount(p.data.plan_id,p.data.account_id,p.data.custom_amount);const discountActive=!p.data.discount_until||new Date(p.data.discount_until)>=new Date(p.data.start_date);if(discountActive)amount=applyDiscount(amount,p.data.discount_type,p.data.discount_value);
    let remote:any=null;const cycle=cycleFor(plan.rows[0].billing_type);
    if(p.data.sync_asaas){if(!cycle)return res.status(400).json({error:'Este tipo de plano não usa assinatura recorrente no Asaas'});if(!account.rows[0].asaas_customer_id)return res.status(409).json({error:'Cadastre/sincronize primeiro o cliente no Asaas'});remote=await asaas('/subscriptions',{method:'POST',body:JSON.stringify({customer:account.rows[0].asaas_customer_id,billingType:p.data.payment_method,value:amount,nextDueDate:p.data.start_date,cycle,description:plan.rows[0].name,externalReference:`hidrocondo:${p.data.account_id}:${p.data.plan_id}`})});}
    const r=await pool.query(`INSERT INTO billing_subscriptions(account_id,plan_id,asaas_subscription_id,status,payment_method,due_day,start_date,custom_amount,discount_type,discount_value,discount_until,grace_days,suspend_after_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[p.data.account_id,p.data.plan_id,remote?.id||null,p.data.sync_asaas?'active':'draft',p.data.payment_method,p.data.due_day??null,p.data.start_date,p.data.custom_amount??null,p.data.discount_type??null,p.data.discount_value??null,p.data.discount_until??null,p.data.grace_days,p.data.suspend_after_days??null]);await pool.query(`UPDATE customer_accounts SET billing_status=$2 WHERE id=$1`,[p.data.account_id,p.data.sync_asaas?'active':'draft']);await audit(req,'create','billing_subscription',r.rows[0].id,{...p.data,amount,asaas_subscription_id:remote?.id});res.status(201).json({...r.rows[0],calculated_amount:amount,asaas:remote});
  });

  app.get('/api/v1/financeiro/cobrancas',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);const r=await pool.query(`SELECT bc.*,ca.name account_name,bp.name plan_name FROM billing_charges bc JOIN customer_accounts ca ON ca.id=bc.account_id LEFT JOIN billing_subscriptions bs ON bs.id=bc.subscription_id LEFT JOIN billing_plans bp ON bp.id=bs.plan_id ORDER BY bc.due_date DESC,bc.created_at DESC LIMIT 1000`);res.json(r.rows);
  });

  app.post('/api/v1/financeiro/cobrancas',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req))return forbidden(res);const p=z.object({account_id:uuid,description:z.string().min(2),amount:z.coerce.number().positive(),due_date:z.string().date(),payment_method:paymentMethod.default('UNDEFINED'),sync_asaas:z.boolean().default(true)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'Cobrança inválida'});const account=await pool.query('SELECT * FROM customer_accounts WHERE id=$1',[p.data.account_id]);if(!account.rowCount)return res.status(404).json({error:'Cliente não encontrado'});let remote:any=null;if(p.data.sync_asaas){if(!account.rows[0].asaas_customer_id)return res.status(409).json({error:'Cliente ainda não sincronizado com Asaas'});remote=await asaas('/payments',{method:'POST',body:JSON.stringify({customer:account.rows[0].asaas_customer_id,billingType:p.data.payment_method,value:p.data.amount,dueDate:p.data.due_date,description:p.data.description,externalReference:`hidrocondo:${p.data.account_id}:${Date.now()}`})});}
    const r=await pool.query(`INSERT INTO billing_charges(account_id,asaas_payment_id,external_reference,description,amount,due_date,payment_method,status,invoice_url,bank_slip_url,raw_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[p.data.account_id,remote?.id||null,remote?.externalReference||null,p.data.description,p.data.amount,p.data.due_date,p.data.payment_method,remote?.status||'PENDING',remote?.invoiceUrl||null,remote?.bankSlipUrl||null,remote?JSON.stringify(remote):null]);await audit(req,'create','billing_charge',r.rows[0].id,{...p.data,asaas_payment_id:remote?.id});res.status(201).json(r.rows[0]);
  });

  app.post('/api/v1/webhooks/asaas',async(req,res)=>{
    const expected=process.env.ASAAS_WEBHOOK_TOKEN?.trim();const supplied=String(req.header('asaas-access-token')||'');if(!expected||!supplied||!secureEqual(expected,supplied))return res.status(401).json({error:'Webhook não autorizado'});
    const body=req.body||{};const resource=body.payment||body.subscription||body.customer||{};const eventType=String(body.event||'UNKNOWN');const eventKey=String(body.id||`${eventType}:${resource.id||''}:${body.dateCreated||''}`)||createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const saved=await pool.query(`INSERT INTO asaas_webhook_events(event_key,event_type,resource_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(event_key) DO NOTHING RETURNING id`,[eventKey,eventType,resource.id||null,JSON.stringify(body)]);if(!saved.rowCount)return res.status(200).json({ok:true,duplicate:true});
    try{
      if(body.payment?.id){const payment=body.payment;await pool.query(`INSERT INTO billing_charges(account_id,asaas_payment_id,external_reference,description,amount,due_date,payment_method,status,invoice_url,bank_slip_url,paid_at,raw_payload) SELECT ca.id,$1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $7 IN('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') THEN now() ELSE NULL END,$10 FROM customer_accounts ca WHERE ca.asaas_customer_id=$11 ON CONFLICT(asaas_payment_id) DO UPDATE SET status=EXCLUDED.status,invoice_url=COALESCE(EXCLUDED.invoice_url,billing_charges.invoice_url),bank_slip_url=COALESCE(EXCLUDED.bank_slip_url,billing_charges.bank_slip_url),paid_at=COALESCE(billing_charges.paid_at,EXCLUDED.paid_at),raw_payload=EXCLUDED.raw_payload,updated_at=now()`,[payment.id,payment.externalReference||null,payment.description||null,Number(payment.value||0),payment.dueDate||new Date().toISOString().slice(0,10),payment.billingType||'UNDEFINED',payment.status||eventType,payment.invoiceUrl||null,payment.bankSlipUrl||null,JSON.stringify(payment),payment.customer]);
        if(payment.customer)await pool.query(`UPDATE customer_accounts SET billing_status=CASE WHEN $2 IN('PAYMENT_OVERDUE') OR $3='OVERDUE' THEN 'overdue' WHEN $3 IN('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') THEN 'active' ELSE billing_status END WHERE asaas_customer_id=$1`,[payment.customer,eventType,payment.status||'']);}
      if(body.subscription?.id)await pool.query(`UPDATE billing_subscriptions SET status=CASE WHEN $2 IN('SUBSCRIPTION_DELETED','SUBSCRIPTION_INACTIVATED') THEN 'cancelled' ELSE status END,updated_at=now(),metadata=metadata||$3::jsonb WHERE asaas_subscription_id=$1`,[body.subscription.id,eventType,JSON.stringify({last_event:eventType})]);
      await pool.query('UPDATE asaas_webhook_events SET processed_at=now() WHERE id=$1',[saved.rows[0].id]);res.status(200).json({ok:true});
    }catch(e){await pool.query('UPDATE asaas_webhook_events SET processing_error=$2 WHERE id=$1',[saved.rows[0].id,e instanceof Error?e.message:String(e)]);throw e;}
  });
}
