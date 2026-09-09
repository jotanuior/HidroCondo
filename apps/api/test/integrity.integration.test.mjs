import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

test('integração PostgreSQL: medição, permissão e histórico',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.TEST_DATABASE_URL);
  assert.match(url.pathname,/_test$/,'Use um banco exclusivo terminado em _test');
  process.env.DATABASE_URL=url.href;
  process.env.JWT_SECRET='test-only-secret-for-measurement-integrity';
  const {pool}=await import('../dist/db.js');
  const {ingestTelemetry}=await import('../dist/telemetry.js');
  const {signToken}=await import('../dist/auth.js');
  const {registerManagementRoutes}=await import('../dist/management.js');
  const {registerCounterRoutes}=await import('../dist/counter.js');
  const {registerScopedReadRoutes}=await import('../dist/scoped-read.js');
  const {registerReportRoutes}=await import('../dist/reports.js');
  const {default:express}=await import('express');
  const root=new URL('../../../',import.meta.url);
  await pool.query(await readFile(new URL('db/init/001_schema.sql',root),'utf8'));
  for(const f of (await readdir(new URL('db/migrations/',root))).sort()) {
    await pool.query(await readFile(new URL(`db/migrations/${f}`,root),'utf8'));
  }
  const app=express();app.use(express.json());
  registerScopedReadRoutes(app);registerManagementRoutes(app);registerCounterRoutes(app);registerReportRoutes(app);
  app.use((err,req,res,next)=>res.status(500).json({error:err.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end()});
  const a=randomUUID(),b=randomUUID(),aa=randomUUID(),ab=randomUUID();
  for(const [id,account] of [[a,aa],[b,ab]]) {
    await pool.query(`INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Admin',$2,'unused','admin')`,[id,`${id}@test.local`]);
    await pool.query('INSERT INTO customer_accounts(id,name,owner_user_id) VALUES($1,$2,$3)',[account,account,id]);
    await pool.query("INSERT INTO account_members(account_id,user_id,role) VALUES($1,$2,'admin')",[account,id]);
  }
  const tokenA=signToken({sub:a,role:'admin',email:'a@test.local'}),tokenB=signToken({sub:b,role:'admin',email:'b@test.local'});
  const request=(path,token,method='GET',body)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const serial=`09${Date.now()}`;
  const payload=(nivel,stamp)=>({numero_serie_sensor:serial,nivel,...(stamp?{timestamp:stamp}:{})});
  let sensor;
  await t.test('heartbeat sem alteração permanece online e gera consumo zero',async()=>{
    const first=await ingestTelemetry(payload('005000'));sensor=first.sensor_id;
    await pool.query('UPDATE sensors SET account_id=$2,conversion_factor=0.001,last_seen_at=now()-interval \'1 hour\' WHERE id=$1',[sensor,aa]);
    const second=await ingestTelemetry(payload('005000'));
    assert.equal(second.delta_raw,0);assert.equal(second.duplicate,false);
    const list=await (await request('/api/v1/sensores',tokenA)).json();
    assert.equal(list.find(x=>x.id===sensor).connection_status,'online');
  });
  await t.test('duplicatas concorrentes somam uma única vez',async()=>{
    const r=await Promise.all([ingestTelemetry(payload('005010'),'same-event'),ingestTelemetry(payload('005010'),'same-event')]);
    assert.equal(r.filter(x=>x.duplicate).length,1);
    assert.equal(Number((await pool.query('SELECT virtual_counter FROM sensors WHERE id=$1',[sensor])).rows[0].virtual_counter),0.01);
  });
  await t.test('reinício bloqueia consumo e preserva referência',async()=>{
    const r=await ingestTelemetry(payload('000010'));assert.equal(r.status,'suspect_decrease');assert.equal(r.delta_raw,0);
    const pending=await ingestTelemetry(payload('005020'));assert.equal(pending.status,'pending_review');
    const s=(await pool.query('SELECT * FROM sensors WHERE id=$1',[sensor])).rows[0];
    assert.equal(s.last_raw_value,5010);assert.equal(s.needs_review,true);
  });
  await t.test('administrador de outra conta não altera nem desativa sensor',async()=>{
    assert.equal((await request(`/api/v1/sensores/${sensor}`,tokenB,'PUT',{conversion_factor:10})).status,403);
    assert.equal((await request(`/api/v1/sensores/${sensor}`,tokenB,'DELETE')).status,403);
    assert.equal((await request(`/api/v1/sensores/${sensor}/leitura-hidrometro`,tokenB,'POST',{reading_m3:0,raw_baseline:10,reason:'Conferência'})).status,403);
  });
  await t.test('conferência libera referência com auditoria e sem apagar leituras',async()=>{
    const r=await request(`/api/v1/sensores/${sensor}/leitura-hidrometro`,tokenA,'POST',{reading_m3:12,raw_baseline:10,reason:'Reinício conferido no local'});
    assert.equal(r.status,200);
    const next=await ingestTelemetry(payload('000012'));assert.equal(next.delta_raw,2);
    const audit=await pool.query("SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='meter_reading_adjustment'",[sensor]);assert.equal(audit.rowCount,1);
  });
  await t.test('timestamp atrasado não altera base nem consumo',async()=>{
    const r=await ingestTelemetry(payload('000001',Date.now()-3600000));assert.equal(r.status,'out_of_order');assert.equal(r.delta_raw,0);
  });
  await t.test('desativação preserva histórico e impede novas cobranças',async()=>{
    assert.equal((await request(`/api/v1/sensores/${sensor}`,tokenA,'DELETE')).status,204);
    const r=await ingestTelemetry(payload('000020'));assert.equal(r.status,'inactive_sensor');assert.equal(r.delta_raw,0);
    const history=await (await request(`/api/v1/telemetria/historico?sensor_id=${sensor}`,tokenA)).json();assert.ok(history.length>=6);
    const day=new Date().toISOString().slice(0,10);
    const report=await (await request('/api/v1/relatorios/consumo',tokenA,'POST',{from:day,to:day})).json();
    assert.equal(report.summary.sensors,1);
    await assert.rejects(pool.query('DELETE FROM sensors WHERE id=$1',[sensor]),{code:'23503'});
  });
  await t.test('desativar usuário invalida token já emitido',async()=>{
    await pool.query('UPDATE users SET active=false WHERE id=$1',[a]);
    assert.equal((await request('/api/v1/sensores',tokenA)).status,401);
  });
});
