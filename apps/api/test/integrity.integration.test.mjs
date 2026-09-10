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
  const {registerOccurrenceRoutes}=await import('../dist/occurrences.js');
  const {registerOperationalDashboard}=await import('../dist/operational-dashboard.js');
  const {evaluateAlerts}=await import('../dist/alert-worker.js');
  const {default:express}=await import('express');
  const root=new URL('../../../',import.meta.url);
  await pool.query(await readFile(new URL('db/init/001_schema.sql',root),'utf8'));
  for(const f of (await readdir(new URL('db/migrations/',root))).sort()) {
    await pool.query(await readFile(new URL(`db/migrations/${f}`,root),'utf8'));
  }
  const app=express();app.use(express.json());
  registerOccurrenceRoutes(app);registerOperationalDashboard(app);registerScopedReadRoutes(app);registerManagementRoutes(app);registerCounterRoutes(app);registerReportRoutes(app);
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
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const report=await (await request('/api/v1/relatorios/consumo',tokenA,'POST',{from:day,to:day})).json();
    assert.equal(report.summary.sensors,1);
    await assert.rejects(pool.query('DELETE FROM sensors WHERE id=$1',[sensor]),{code:'23503'});
  });

  const condo=randomUUID(),block=randomUUID(),unit=randomUUID(),unit2=randomUUID(),resident=randomUUID();
  await pool.query(`INSERT INTO condominiums(id,name,account_id) VALUES($1,'Teste operacional',$2)`,[condo,aa]);
  await pool.query(`INSERT INTO buildings(id,name,condominium_id) VALUES($1,'Bloco A',$2)`,[block,condo]);
  await pool.query(`INSERT INTO units(id,identifier,building_id) VALUES($1,'101',$3),($2,'102',$3)`,[unit,unit2,block]);
  await pool.query(`INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Morador',$2,'unused','morador')`,[resident,`${resident}@test.local`]);
  await pool.query(`INSERT INTO access_grants(user_id,scope_type,scope_id,role) VALUES($1,'unit',$2,'morador')`,[resident,unit]);
  const tokenR=signToken({sub:resident,role:'morador',email:'r@test.local'});
  const monitored=randomUUID();
  await pool.query(`INSERT INTO sensors(id,serial,sensor_type,account_id,unit_id,last_seen_at,created_at)
    VALUES($1,'099999888877','09',$2,$3,now()-interval '2 hours',now()-interval '1 day')`,[monitored,aa,unit]);
  let occurrence,rule;
  const json=async path=>{const r=await request(path,tokenA);const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body};
  await t.test('regras validam limites e respeitam contas',async()=>{
    assert.equal((await request('/api/v1/alertas',tokenB,'POST',{condominium_id:condo,type:'offline',config:{minutes:30}})).status,403);
    assert.equal((await request('/api/v1/alertas',tokenA,'POST',{condominium_id:condo,type:'offline',config:{minutes:0}})).status,400);
    const r=await request('/api/v1/alertas',tokenA,'POST',{condominium_id:condo,type:'offline',config:{minutes:30}});
    assert.equal(r.status,201);rule=(await r.json()).id;
    await pool.query(`INSERT INTO alert_rules(condominium_id,type,config) VALUES($1,'offline','{"minutes":"invalid"}')`,[condo]);
  });
  await t.test('avaliação repetida abre apenas uma ocorrência contínua',async()=>{
    await evaluateAlerts();await evaluateAlerts();
    const list=await json('/api/v1/ocorrencias');assert.equal(list.items.length,1);occurrence=list.items[0].id;
    assert.equal(list.items[0].can_operate,true);assert.ok(list.last_evaluated_at);
    const other=await (await request('/api/v1/ocorrencias',tokenB)).json();assert.equal(other.items.length,0);
    const own=await (await request('/api/v1/ocorrencias',tokenR)).json();assert.equal(own.items.length,1);assert.equal(own.items[0].can_operate,false);
  });
  await t.test('morador consulta mas não atende; outra conta não lê histórico',async()=>{
    assert.equal((await request(`/api/v1/ocorrencias/${occurrence}/acao`,tokenR,'POST',{action:'acknowledge'})).status,403);
    assert.equal((await request(`/api/v1/ocorrencias/${occurrence}/eventos`,tokenB)).status,403);
    assert.equal((await request(`/api/v1/ocorrencias/${occurrence}/acao`,tokenB,'POST',{action:'acknowledge'})).status,403);
  });
  await t.test('atendimento idempotente e resolução auditada com justificativa',async()=>{
    for(let i=0;i<2;i++)assert.equal((await request(`/api/v1/ocorrencias/${occurrence}/acao`,tokenA,'POST',{action:'acknowledge'})).status,200);
    const events=await json(`/api/v1/ocorrencias/${occurrence}/eventos`);assert.equal(events.filter(x=>x.action==='acknowledge').length,1);assert.equal(events[1].actor_id,a);
    assert.equal((await request(`/api/v1/ocorrencias/${occurrence}/acao`,tokenA,'POST',{action:'resolve'})).status,400);
    assert.equal((await request(`/api/v1/ocorrencias/${occurrence}/acao`,tokenA,'POST',{action:'resolve',note:'Equipamento em manutenção'})).status,200);
    await evaluateAlerts();assert.equal((await json('/api/v1/ocorrencias')).items.length,1);
  });
  await t.test('recuperação encerra condição e reincidência gera nova ocorrência',async()=>{
    await pool.query('UPDATE sensors SET last_seen_at=now() WHERE id=$1',[monitored]);await evaluateAlerts();
    assert.equal((await json('/api/v1/ocorrencias')).items[0].condition_active,false);
    await pool.query("UPDATE sensors SET last_seen_at=now()-interval '2 hours' WHERE id=$1",[monitored]);await evaluateAlerts();
    assert.equal((await json('/api/v1/ocorrencias')).items.length,2);
  });
  await t.test('pendência de leitura independe de regra; sensor nunca visto gera offline',async()=>{
    await pool.query('UPDATE sensors SET needs_review=true,last_seen_at=NULL WHERE id=$1',[monitored]);await evaluateAlerts();
    const items=(await json('/api/v1/ocorrencias?status=open')).items;
    assert.ok(items.some(x=>x.kind==='measurement_review'));assert.ok(items.some(x=>x.kind==='offline'));
  });
  await t.test('consumo usa janela móvel e ignora regra legada inválida',async()=>{
    await pool.query(`INSERT INTO telemetry_readings(sensor_id,raw_value,conversion_factor,consumption_m3,event_key,raw_payload,received_at)
      VALUES($1,0,1,100,$2,'{}',now()-interval '2 days'),($1,1,1,0.5,$3,'{}',now()-interval '1 minute')`,[monitored,randomUUID(),randomUUID()]);
    const r=await request('/api/v1/alertas',tokenA,'POST',{condominium_id:condo,type:'consumption',config:{threshold_m3:0.25,window_minutes:60}});assert.equal(r.status,201);
    await evaluateAlerts();const items=(await json('/api/v1/ocorrencias')).items.filter(x=>x.kind==='consumption');assert.equal(items.length,1);assert.equal(items[0].details.consumption_m3,0.5);
  });
  await t.test('dashboard por perfil isola sensores, consumo e filtros',async()=>{
    const own=await (await request('/api/v1/dashboard/operacional',tokenR)).json();assert.equal(own.profile,'resident',JSON.stringify(own));assert.equal(own.summary.sensors,1);assert.equal(own.summary.needs_review,1);assert.equal(own.series.length,14);assert.equal(own.units.length,1);
    const other=await (await request('/api/v1/dashboard/operacional',tokenB)).json();assert.equal(other.summary.sensors,0);assert.equal(other.summary.month_m3,0);assert.equal(other.summary.change_percent,null);
    const filtered=await json('/api/v1/dashboard/operacional?condominium_id='+randomUUID());assert.equal(filtered.summary.sensors,0);
    assert.equal((await request('/api/v1/dashboard/operacional?condominium_id=bad',tokenA)).status,400);
  });
  await t.test('dias do gráfico seguem meia-noite de Brasília',async()=>{
    const dates=(await pool.query(`SELECT to_char(date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')-interval '5 days','YYYY-MM-DD') AS day,
      to_char(date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')-interval '6 days','YYYY-MM-DD') previous`)).rows[0];
    await pool.query(`INSERT INTO telemetry_readings(sensor_id,raw_value,conversion_factor,consumption_m3,event_key,raw_payload,received_at)
      VALUES($1,0,1,2,$2,'{}',($4::date+time '00:01') AT TIME ZONE 'America/Sao_Paulo'),
      ($1,0,1,3,$3,'{}',($4::date+time '00:00') AT TIME ZONE 'America/Sao_Paulo'-interval '1 minute')`,[monitored,randomUUID(),randomUUID(),dates.day]);
    const dash=await json('/api/v1/dashboard/operacional');
    assert.equal(dash.series.find(x=>x.day===dates.day).consumption_m3,2);
    assert.equal(dash.series.find(x=>x.day===dates.previous).consumption_m3,3);
  });
  await t.test('transferência preserva acesso ao histórico original das ocorrências',async()=>{
    await pool.query(`INSERT INTO sensor_installations(sensor_id,unit_id,installed_at,removed_at) VALUES($1,$2,now()-interval '30 days',now())`,[monitored,unit]);
    await pool.query('INSERT INTO sensor_installations(sensor_id,unit_id) VALUES($1,$2)',[monitored,unit2]);
    await pool.query('UPDATE sensors SET unit_id=$2 WHERE id=$1',[monitored,unit2]);await evaluateAlerts();
    const list=await (await request('/api/v1/ocorrencias',tokenR)).json();assert.ok(list.items.length>0);assert.ok(list.items.every(x=>x.unit_id===unit&&!x.condition_active));
    const dash=await (await request('/api/v1/dashboard/operacional',tokenR)).json();assert.equal(dash.summary.sensors,0);
    const nextResident=randomUUID();
    await pool.query(`INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Novo morador',$2,'unused','morador')`,[nextResident,`${nextResident}@test.local`]);
    await pool.query(`INSERT INTO access_grants(user_id,scope_type,scope_id,role) VALUES($1,'unit',$2,'morador')`,[nextResident,unit2]);
    const nextToken=signToken({sub:nextResident,role:'morador',email:'next@test.local'});
    const nextDashboard=await (await request('/api/v1/dashboard/operacional',nextToken)).json();
    assert.equal(nextDashboard.summary.sensors,1);assert.equal(nextDashboard.summary.month_m3,0);
  });
  await t.test('pausar regra encerra condições sem remover histórico',async()=>{
    assert.equal((await request('/api/v1/alertas/'+rule,tokenA,'PATCH',{enabled:false})).status,200);await evaluateAlerts();
    const list=await json('/api/v1/ocorrencias');assert.ok(list.items.filter(x=>x.rule_id===rule).every(x=>!x.condition_active));
  });

  await t.test('desativar usuário invalida token já emitido',async()=>{
    await pool.query('UPDATE users SET active=false WHERE id=$1',[a]);
    assert.equal((await request('/api/v1/sensores',tokenA)).status,401);
  });
});