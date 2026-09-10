import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from './db.js';

const uuid=z.string().uuid();

type ProtectedEntity={prefix:string;table:string;label:string};
const protectedEntities:ProtectedEntity[]=[
  {prefix:'/api/v1/condominios/',table:'condominiums',label:'condomínio'},
  {prefix:'/api/v1/unidades/',table:'units',label:'unidade'},
  {prefix:'/api/v1/sensores/',table:'sensors',label:'sensor'}
];

/**
 * Dados cujo source contém SCAE têm o SCAE como fonte de verdade.
 * Impede que PUT/DELETE comuns criem divergência. A autenticação e as
 * permissões continuam sendo validadas pelas rotas de gestão originais.
 */
export function registerScaeManagedGuard(app:Express){
  app.use(async(req:Request,res:Response,next:NextFunction)=>{
    if(req.method!=='PUT'&&req.method!=='DELETE')return next();
    const entity=protectedEntities.find(x=>req.path.startsWith(x.prefix));
    if(!entity)return next();
    const id=req.path.slice(entity.prefix.length).split('/')[0];
    if(!uuid.safeParse(id).success)return next();
    const q=await pool.query(`SELECT source FROM ${entity.table} WHERE id=$1`,[id]);
    if(!q.rowCount)return next();
    const source=String(q.rows[0].source||'HIDROCONDO').toUpperCase();
    if(source==='SCAE'||source==='HIDROCONDO+SCAE'){
      return res.status(409).json({
        error:`Este ${entity.label} é sincronizado pelo SCAE e não pode ser editado ou removido diretamente no HidroCondo. Faça a alteração no SCAE.`,
        code:'SCAE_MANAGED_RECORD',
        source
      });
    }
    next();
  });
}
