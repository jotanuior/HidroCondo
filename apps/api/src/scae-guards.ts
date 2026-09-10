import type { Express, NextFunction, Response } from 'express';
import { pool } from './db.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';

async function isScaeOwned(path: string, id: string) {
  if (path.startsWith('/api/v1/condominios/')) {
    const q=await pool.query('SELECT scae_condominium_id IS NOT NULL AS managed FROM condominiums WHERE id=$1',[id]);
    return q.rows[0]?.managed===true;
  }
  if (path.startsWith('/api/v1/unidades/')) {
    const q=await pool.query('SELECT scae_installation_point_id IS NOT NULL AS managed FROM units WHERE id=$1',[id]);
    return q.rows[0]?.managed===true;
  }
  if (path.startsWith('/api/v1/sensores/')) {
    const q=await pool.query('SELECT scae_sensor_id IS NOT NULL AS managed FROM sensors WHERE id=$1',[id]);
    return q.rows[0]?.managed===true;
  }
  return false;
}

export function registerScaeMutationGuards(app: Express) {
  const guard=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    const id=req.params.id;
    if (!id) return next();
    if (!await isScaeOwned(req.path,id)) return next();
    const forced=req.auth?.role==='superadmin' && String(req.query.force_scae??'').toLowerCase()==='true';
    if (forced) return next();
    return res.status(409).json({
      error:'Registro sincronizado pelo SCAE. Edite ou desative no SCAE para manter os sistemas consistentes.',
      source:'SCAE',
      read_only:true,
      superadmin_override:'Adicione ?force_scae=true somente para correção administrativa excepcional.'
    });
  };

  app.put('/api/v1/condominios/:id',requireAuth,guard);
  app.delete('/api/v1/condominios/:id',requireAuth,guard);
  app.put('/api/v1/unidades/:id',requireAuth,guard);
  app.delete('/api/v1/unidades/:id',requireAuth,guard);
  app.put('/api/v1/sensores/:id',requireAuth,guard);
  app.delete('/api/v1/sensores/:id',requireAuth,guard);
}
