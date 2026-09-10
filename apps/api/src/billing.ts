import type { Express, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

const uuid=z.string().uuid();
const cycle=z.enum(['WEEKLY','BIWEEKLY','MONTHLY','BIMONTHLY','QUARTERLY','SEMIANNUALLY','YEARLY']);
const billingType=z.enum(['BOLETO','PIX','CREDIT_CARD','UNDEFINED']);
const isSuper=(req:AuthenticatedRequest)=>req.auth?.role==='superadmin';
const forbidden=(res:Response)=>res.status(403).json({error:'Somente superadministrador pode gerenciar cobrança'});

function baseUrl(){
  return (process.env.ASAAS_ENV??'sandbox').toLowerCase()==='production'
    ? 'https://api.asaas.com/v3'
    : 'https://api-sandbox.asaas.com/v3';
}

async function asaas(path:string,init:RequestInit={}){
  const key=process.env.ASAAS_API_KEY;
  if(!key) throw new Error('ASAAS_API_KEY não configurada');
  const response=await fetch(`${baseUrl()}${path}`,{
    ...init,
    headers:{'content-type':'application/json','access_token':key,...(init.headers??{})}
  });
  const text=await response.text();
  let body:any={};
  try{body=text?JSON.parse(text):{};}catch{body={raw:text};}
  if(!response.ok) throw new Error(body?.errors?.map((x:any)=>x.description).join('; ')||body?.error||`Asaas HTTP ${response.status}`);
  return body;
}

async function audit(req:AuthenticatedRequest,action:string,accountId:string|null,payload?:unknown){
  await pool.query('INSERT INTO billing_audit_log(user_id,account_id,action,payload) VALUES($1,$2,$3,$4::jsonb)',[
    req.auth?.sub??null,accountId,action,payload?JSON.stringify(payload):null
  ]);
}

function amountForPlan(plan:any,activeSensors:number){
  const fixed=Number(plan.amount||0);
  if(plan.billing_mode==='fixed') return fixed;
  if(plan.billing_mode==='per_sensor') return Number(plan.base_amount||0)+Number(plan.per_sensor_amount||0)*activeSensors;
  const tiers=Array.isArray(plan.tiers)?plan.tiers:[];
  const match=tiers.find((t:any)=>activeSensors>=Number(t.min??0)&&(t.max==null||activeSensors<=Number(t.max)));
  return match?Number(match.amount):fixed;
}

async function activeSensorCount(accountId:string){
  const q=await pool.query('SELECT COUNT(*)::int n FROM sensors WHERE account_id=$1 AND active=true',[accountId]);
  return Number(q.rows[0]?.n??0);
}

function applyDiscount(amount:number,account:any){
  const today=new Date().toISOString().slice(0,10);
  if(account.billing_exempt_until && String(account.billing_exempt_until).slice(0,10)>=today) return 0;
  if(!account.billing_discount_type || !account.billing_discount_value) return amount;
  if(account.billing_discount_until && String(account.billing_discount_until).slice(0,10)<today) return amount;
  const value=Number(account.billing_discount_value);
  return account.billing_discount_type==='percent' ? Math.max(0,amount-(amount*value/100)) : Math.max(0,amount-value);
}

export function registerBillingRoutes(app:Express){
  app.get('/api/v1/billing/plans',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    const q=await pool.query('SELECT * FROM billing_plans ORDER BY active DESC,name');
    res.json(q.rows);
  });

  app.post('/api/v1/billing/plans',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    const p=z.object({
      name:z.string().trim().min(2),description:z.string().trim().optional().nullable(),
      charge_type:z.enum(['recurring','single']),cycle:cycle.optional().nullable(),
      amount:z.coerce.number().min(0),billing_mode:z.enum(['fixed','per_sensor','tiered']).default('fixed'),
      base_amount:z.coerce.number().min(0).default(0),per_sensor_amount:z.coerce.number().min(0).default(0),
      tiers:z.array(z.object({min:z.coerce.number().int().min(0),max:z.coerce.number().int().min(0).nullable().optional(),amount:z.coerce.number().min(0)})).default([]),
      active:z.boolean().default(true)
    }).safeParse(req.body);
    if(!p.success || (p.data.charge_type==='recurring'&&!p.data.cycle) || (p.data.charge_type==='single'&&p.data.cycle)) return res.status(400).json({error:'Plano inválido'});
    const d=p.data;
    const q=await pool.query(`INSERT INTO billing_plans(name,description,charge_type,cycle,amount,billing_mode,base_amount,per_sensor_amount,tiers,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,[d.name,d.description??null,d.charge_type,d.cycle??null,d.amount,d.billing_mode,d.base_amount,d.per_sensor_amount,JSON.stringify(d.tiers),d.active]);
    await audit(req,'plan.create',null,q.rows[0]);
    res.status(201).json(q.rows[0]);
  });

  app.put('/api/v1/billing/plans/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    if(!uuid.safeParse(req.params.id).success) return res.status(400).json({error:'Plano inválido'});
    const p=z.object({name:z.string().trim().min(2),description:z.string().trim().optional().nullable(),amount:z.coerce.number().min(0),active:z.boolean(),billing_mode:z.enum(['fixed','per_sensor','tiered']),base_amount:z.coerce.number().min(0),per_sensor_amount:z.coerce.number().min(0),tiers:z.array(z.any()).default([])}).safeParse(req.body);
    if(!p.success) return res.status(400).json({error:'Plano inválido'});
    const d=p.data;
    const q=await pool.query(`UPDATE billing_plans SET name=$2,description=$3,amount=$4,active=$5,billing_mode=$6,base_amount=$7,per_sensor_amount=$8,tiers=$9::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,d.name,d.description??null,d.amount,d.active,d.billing_mode,d.base_amount,d.per_sensor_amount,JSON.stringify(d.tiers)]);
    if(!q.rowCount) return res.status(404).json({error:'Plano não encontrado'});
    await audit(req,'plan.update',null,q.rows[0]);
    res.json(q.rows[0]);
  });

  app.get('/api/v1/billing/accounts',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    const q=await pool.query(`SELECT a.id,a.name,a.asaas_customer_id,a.billing_status,a.billing_plan_id,a.billing_due_day,a.billing_discount_type,a.billing_discount_value,a.billing_discount_until,a.billing_exempt_until,
      p.name plan_name,p.charge_type,p.cycle,p.amount,p.billing_mode,
      (SELECT COUNT(*)::int FROM sensors s WHERE s.account_id=a.id AND s.active=true) active_sensors,
      (SELECT status FROM billing_charges bc WHERE bc.account_id=a.id ORDER BY created_at DESC LIMIT 1) last_charge_status,
      (SELECT due_date FROM billing_charges bc WHERE bc.account_id=a.id ORDER BY created_at DESC LIMIT 1) last_due_date
      FROM customer_accounts a LEFT JOIN billing_plans p ON p.id=a.billing_plan_id ORDER BY a.name`);
    res.json(q.rows);
  });

  app.put('/api/v1/billing/accounts/:id/config',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    if(!uuid.safeParse(req.params.id).success) return res.status(400).json({error:'Conta inválida'});
    const p=z.object({billing_plan_id:uuid.nullable(),billing_due_day:z.coerce.number().int().min(1).max(28).nullable(),billing_discount_type:z.enum(['fixed','percent']).nullable(),billing_discount_value:z.coerce.number().min(0).nullable(),billing_discount_until:z.string().date().nullable(),billing_exempt_until:z.string().date().nullable()}).safeParse(req.body);
    if(!p.success) return res.status(400).json({error:'Configuração inválida'});
    const d=p.data;
    const q=await pool.query(`UPDATE customer_accounts SET billing_plan_id=$2,billing_due_day=$3,billing_discount_type=$4,billing_discount_value=$5,billing_discount_until=$6,billing_exempt_until=$7 WHERE id=$1 RETURNING *`,[req.params.id,d.billing_plan_id,d.billing_due_day,d.billing_discount_type,d.billing_discount_value,d.billing_discount_until,d.billing_exempt_until]);
    if(!q.rowCount) return res.status(404).json({error:'Conta não encontrada'});
    await audit(req,'account.config',req.params.id,d);
    res.json(q.rows[0]);
  });

  app.post('/api/v1/billing/accounts/:id/asaas-customer',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    if(!uuid.safeParse(req.params.id).success) return res.status(400).json({error:'Conta inválida'});
    const p=z.object({name:z.string().min(2),cpfCnpj:z.string().min(11),email:z.string().email().optional(),mobilePhone:z.string().optional()}).safeParse(req.body);
    if(!p.success) return res.status(400).json({error:'Dados do pagador inválidos'});
    const account=await pool.query('SELECT id,asaas_customer_id FROM customer_accounts WHERE id=$1',[req.params.id]);
    if(!account.rowCount) return res.status(404).json({error:'Conta não encontrada'});
    let customer;
    if(account.rows[0].asaas_customer_id){
      customer=await asaas(`/customers/${account.rows[0].asaas_customer_id}`,{method:'PUT',body:JSON.stringify({...p.data,externalReference:req.params.id})});
    }else{
      customer=await asaas('/customers',{method:'POST',body:JSON.stringify({...p.data,externalReference:req.params.id})});
      await pool.query("UPDATE customer_accounts SET asaas_customer_id=$2,billing_status='configured' WHERE id=$1",[req.params.id,customer.id]);
    }
    await audit(req,'asaas.customer.sync',req.params.id,{customer_id:customer.id});
    res.json({ok:true,customer_id:customer.id});
  });

  app.post('/api/v1/billing/accounts/:id/generate',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    if(!uuid.safeParse(req.params.id).success) return res.status(400).json({error:'Conta inválida'});
    const extra=z.object({billing_type:billingType.default('UNDEFINED'),due_date:z.string().date().optional(),description:z.string().max(500).optional()}).safeParse(req.body??{});
    if(!extra.success) return res.status(400).json({error:'Parâmetros inválidos'});
    const q=await pool.query(`SELECT a.*,p.* FROM customer_accounts a JOIN billing_plans p ON p.id=a.billing_plan_id WHERE a.id=$1 AND p.active=true`,[req.params.id]);
    const row=q.rows[0];
    if(!row) return res.status(409).json({error:'Conta sem plano ativo'});
    if(!row.asaas_customer_id) return res.status(409).json({error:'Cliente ainda não sincronizado com o Asaas'});
    const sensors=await activeSensorCount(req.params.id);
    const amount=Number(applyDiscount(amountForPlan(row,sensors),row).toFixed(2));
    const due=extra.data.due_date??new Date(Date.now()+86400000*5).toISOString().slice(0,10);
    if(row.charge_type==='recurring'){
      const remote=await asaas('/subscriptions',{method:'POST',body:JSON.stringify({customer:row.asaas_customer_id,billingType:extra.data.billing_type,value:amount,nextDueDate:due,cycle:row.cycle,description:extra.data.description??row.name,externalReference:req.params.id})});
      const local=await pool.query(`INSERT INTO billing_subscriptions(account_id,plan_id,provider_subscription_id,amount,cycle,billing_type,next_due_date,status) VALUES($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,[req.params.id,row.billing_plan_id,remote.id,amount,row.cycle,extra.data.billing_type,due]);
      await audit(req,'asaas.subscription.create',req.params.id,{provider_subscription_id:remote.id,amount,sensors});
      return res.status(201).json({ok:true,type:'subscription',subscription:local.rows[0]});
    }
    const remote=await asaas('/payments',{method:'POST',body:JSON.stringify({customer:row.asaas_customer_id,billingType:extra.data.billing_type,value:amount,dueDate:due,description:extra.data.description??row.name,externalReference:req.params.id})});
    const local=await pool.query(`INSERT INTO billing_charges(account_id,provider_payment_id,amount,due_date,billing_type,status,description,invoice_url,bank_slip_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.params.id,remote.id,amount,due,extra.data.billing_type,String(remote.status??'PENDING').toLowerCase(),extra.data.description??row.name,remote.invoiceUrl??null,remote.bankSlipUrl??null]);
    await audit(req,'asaas.payment.create',req.params.id,{provider_payment_id:remote.id,amount,sensors});
    res.status(201).json({ok:true,type:'payment',charge:local.rows[0]});
  });

  app.get('/api/v1/billing/charges',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!isSuper(req)) return forbidden(res);
    const q=await pool.query(`SELECT c.*,a.name account_name FROM billing_charges c JOIN customer_accounts a ON a.id=c.account_id ORDER BY c.created_at DESC LIMIT 500`);
    res.json(q.rows);
  });

  app.post('/api/v1/billing/asaas/webhook',async(req,res)=>{
    const expected=process.env.ASAAS_WEBHOOK_TOKEN;
    const supplied=req.header('asaas-access-token')??req.header('x-asaas-token');
    if(!expected || !supplied || supplied!==expected) return res.status(401).json({error:'Webhook não autorizado'});
    const parsed=z.object({id:z.string().min(1),event:z.string().min(1),payment:z.any().optional(),subscription:z.any().optional()}).passthrough().safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:'Evento inválido'});
    const evt=parsed.data;
    const inserted=await pool.query(`INSERT INTO billing_webhook_events(provider,provider_event_id,event_type,payload) VALUES('asaas',$1,$2,$3::jsonb) ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id`,[evt.id,evt.event,JSON.stringify(evt)]);
    if(!inserted.rowCount) return res.json({ok:true,duplicate:true});
    const payment=evt.payment as any;
    if(payment?.id){
      const status=String(payment.status??evt.event).toLowerCase();
      await pool.query(`UPDATE billing_charges SET status=$2,paid_at=CASE WHEN $2 IN('received','confirmed','payment_received','payment_confirmed') THEN COALESCE(paid_at,now()) ELSE paid_at END,invoice_url=COALESCE($3,invoice_url),bank_slip_url=COALESCE($4,bank_slip_url),updated_at=now() WHERE provider='asaas' AND provider_payment_id=$1`,[payment.id,status,payment.invoiceUrl??null,payment.bankSlipUrl??null]);
      const ext=payment.externalReference;
      if(ext && uuid.safeParse(ext).success){
        const paid=['received','confirmed','payment_received','payment_confirmed'].includes(status);
        const overdue=['overdue','payment_overdue'].includes(status);
        if(paid) await pool.query("UPDATE customer_accounts SET billing_status='active' WHERE id=$1",[ext]);
        else if(overdue) await pool.query("UPDATE customer_accounts SET billing_status='overdue' WHERE id=$1",[ext]);
      }
    }
    const subscription=evt.subscription as any;
    if(subscription?.id){
      await pool.query(`UPDATE billing_subscriptions SET status=$2,active=CASE WHEN $2 IN('deleted','inactive','subscription_deleted','subscription_inactivated') THEN false ELSE active END,updated_at=now() WHERE provider='asaas' AND provider_subscription_id=$1`,[subscription.id,String(subscription.status??evt.event).toLowerCase()]);
    }
    await pool.query('UPDATE billing_webhook_events SET processed_at=now() WHERE provider=$1 AND provider_event_id=$2',['asaas',evt.id]);
    res.json({ok:true});
  });
}
