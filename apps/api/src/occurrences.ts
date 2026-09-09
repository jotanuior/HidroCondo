import type { Express } from 'express';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';
import { scopePermission } from './operation-scope.js';
import { canManageCondominium } from './sensor-management.js';

async function auditRule(req:AuthenticatedRequest,action:string,id:string,payload:unknown){
  await pool.query('INSERT INTO audit_log(user_id,action,entity_type,entity_id,payload) VALUES($1,$2,\'alert_rule\',$3,$4)',[req.auth!.sub,action,id,JSON.stringify(payload)]);
}
const operatorRoles=['admin','sindico','zelador'];
const ruleSchema=z.discriminatedUnion('type',[
  z.object({condominium_id:z.string().uuid(),type:z.literal('offline'),enabled:z.boolean().default(true),
    config:z.object({minutes:z.number().int().min(1).max(10080)})}),
  z.object({condominium_id:z.string().uuid(),type:z.literal('consumption'),enabled:z.boolean().default(true),
    config:z.object({threshold_m3:z.number().finite().positive().max(999999999),window_minutes:z.number().int().min(1).max(10080).default(1440)})})
]);

export function registerOccurrenceRoutes(app: Express) {
  app.get('/api/v1/ocorrencias',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const p=z.object({status:z.enum(['all','open','acknowledged','resolved']).default('all'),
      condominium_id:z.string().uuid().optional(),page:z.coerce.number().int().min(1).max(100000).default(1),
      limit:z.coerce.number().int().min(1).max(100).default(20)}).safeParse(req.query);
    if(!p.success)return res.status(400).json({error:'Filtros inválidos'});
    const v=p.data,params=[req.auth!.role==='superadmin',req.auth!.sub,null,v.condominium_id??null];
    const scoped=`SELECT o.* FROM alert_occurrences o WHERE ${scopePermission('o')}
      AND ($4::uuid IS NULL OR o.condominium_id=$4)`;
    const stats=await pool.query(`WITH visible AS(${scoped}) SELECT
      COUNT(*) FILTER(WHERE status='open')::int open,
      COUNT(*) FILTER(WHERE status='acknowledged')::int acknowledged,
      COUNT(*) FILTER(WHERE status='resolved')::int resolved,
      COUNT(*) FILTER(WHERE $5='all' OR status=$5)::int total FROM visible`,[...params,v.status]);
    const q=await pool.query(`WITH visible AS(${scoped}) SELECT v.*,($9::boolean AND ${scopePermission('v').replaceAll('$3','$8')}) can_operate,u.name acknowledged_by_name,r.name resolved_by_name
      FROM visible v LEFT JOIN users u ON u.id=v.acknowledged_by LEFT JOIN users r ON r.id=v.resolved_by
      WHERE ($5='all' OR v.status=$5) ORDER BY v.opened_at DESC,v.id LIMIT $6 OFFSET $7`,
      [...params,v.status,v.limit,(v.page-1)*v.limit,operatorRoles,['superadmin',...operatorRoles].includes(req.auth!.role)]);
    const evaluated=await pool.query('SELECT last_success_at FROM alert_evaluation_state WHERE id=1');
    res.json({items:q.rows,summary:stats.rows[0],page:v.page,limit:v.limit,last_evaluated_at:evaluated.rows[0]?.last_success_at??null});
  });

  app.get('/api/v1/ocorrencias/:id/eventos',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'Ocorrência inválida'});
    const allowed=await pool.query(`SELECT o.id FROM alert_occurrences o WHERE o.id=$4 AND ${scopePermission('o')}`,
      [req.auth!.role==='superadmin',req.auth!.sub,null,req.params.id]);
    if(!allowed.rowCount)return res.status(403).json({error:'Sem acesso à ocorrência'});
    const q=await pool.query(`SELECT e.*,u.name actor_name FROM alert_occurrence_events e LEFT JOIN users u ON u.id=e.actor_id
      WHERE occurrence_id=$1 ORDER BY e.created_at,e.id`,[req.params.id]);res.json(q.rows);
  });

  app.post('/api/v1/ocorrencias/:id/acao',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!['superadmin',...operatorRoles].includes(req.auth!.role))return res.status(403).json({error:'Perfil sem permissão para atender ocorrências'});
    const p=z.object({action:z.enum(['acknowledge','resolve']),note:z.string().trim().max(1000).default('')}).safeParse(req.body);
    if(!z.string().uuid().safeParse(req.params.id).success||!p.success)return res.status(400).json({error:'Dados inválidos'});
    if(p.data.action==='resolve'&&p.data.note.length<3)return res.status(400).json({error:'Descreva como a ocorrência foi resolvida'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const q=await client.query(`SELECT o.* FROM alert_occurrences o WHERE o.id=$4 AND ${scopePermission('o')} FOR UPDATE`,
        [req.auth!.role==='superadmin',req.auth!.sub,operatorRoles,req.params.id]);
      if(!q.rowCount){await client.query('ROLLBACK');return res.status(403).json({error:'Sem permissão para atender esta ocorrência'});}
      const o=q.rows[0],target=p.data.action==='resolve'?'resolved':'acknowledged';
      if(o.status===target){await client.query('COMMIT');return res.json(o);}
      if(o.status==='resolved'){await client.query('ROLLBACK');return res.status(409).json({error:'Ocorrência já resolvida'});}
      const r=p.data.action==='acknowledge'
        ? await client.query(`UPDATE alert_occurrences SET status='acknowledged',acknowledged_at=now(),acknowledged_by=$2 WHERE id=$1 RETURNING *`,[o.id,req.auth!.sub])
        : await client.query(`UPDATE alert_occurrences SET status='resolved',resolved_at=now(),resolved_by=$2,resolution_note=$3 WHERE id=$1 RETURNING *`,[o.id,req.auth!.sub,p.data.note]);
      await client.query(`INSERT INTO alert_occurrence_events(occurrence_id,actor_id,action,note) VALUES($1,$2,$3,$4)`,[o.id,req.auth!.sub,p.data.action,p.data.note]);
      await client.query('COMMIT');res.json(r.rows[0]);
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });

  app.get('/api/v1/alertas',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const q=await pool.query(`WITH rule_scope AS(SELECT a.*,c.name condominium_name,c.account_id,
      NULL::uuid building_id,NULL::uuid unit_id,NULL::uuid sensor_id FROM alert_rules a JOIN condominiums c ON c.id=a.condominium_id)
      SELECT o.id,o.condominium_id,o.condominium_name,o.type,o.enabled,o.config FROM rule_scope o
      WHERE ${scopePermission('o')} ORDER BY o.condominium_name,o.created_at`,[req.auth!.role==='superadmin',req.auth!.sub,['admin']]);
    res.json(q.rows);
  });
  app.post('/api/v1/alertas',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const p=ruleSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:'Informe limite positivo e período entre 1 e 10080 minutos'});
    if(!await canManageCondominium(req,p.data.condominium_id))return res.status(403).json({error:'Sem permissão para configurar alertas neste condomínio'});
    const v=p.data,q=await pool.query(`INSERT INTO alert_rules(condominium_id,type,enabled,config) VALUES($1,$2,$3,$4) RETURNING *`,[v.condominium_id,v.type,v.enabled,JSON.stringify(v.config)]);
    await auditRule(req,'create',q.rows[0].id,v);res.status(201).json(q.rows[0]);
  });
  app.patch('/api/v1/alertas/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    const p=z.object({enabled:z.boolean()}).safeParse(req.body);
    if(!p.success||!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'Dados inválidos'});
    const q=await pool.query('SELECT condominium_id FROM alert_rules WHERE id=$1',[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:'Regra não encontrada'});
    if(!await canManageCondominium(req,q.rows[0].condominium_id))return res.status(403).json({error:'Sem permissão para esta regra'});
    const r=await pool.query('UPDATE alert_rules SET enabled=$2 WHERE id=$1 RETURNING *',[req.params.id,p.data.enabled]);await auditRule(req,'update',String(req.params.id),p.data);res.json(r.rows[0]);
  });
  app.delete('/api/v1/alertas/:id',requireAuth,async(req:AuthenticatedRequest,res)=>{
    if(!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'Regra inválida'});
    const q=await pool.query('SELECT condominium_id FROM alert_rules WHERE id=$1',[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:'Regra não encontrada'});
    if(!await canManageCondominium(req,q.rows[0].condominium_id))return res.status(403).json({error:'Sem permissão para esta regra'});
    await pool.query('DELETE FROM alert_rules WHERE id=$1',[req.params.id]);await auditRule(req,'delete',String(req.params.id),q.rows[0]);res.status(204).end();
  });
}
