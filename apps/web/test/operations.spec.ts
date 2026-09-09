import {test,expect,type Page} from '@playwright/test';
async function setup(page:Page,role='admin',fail=false){
  await page.addInitScript(role=>localStorage.setItem('hidrocondo.session',JSON.stringify({token:'test',user:{id:'test',name:'Pessoa Teste',email:'test@example.com',role}})),role);
  let status='open';
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    let body:unknown=[];
    if(path.endsWith('/dashboard/operacional')){
      if(fail)return route.fulfill({status:500,json:{error:'Falha de conexão'}});
      body={profile:role==='morador'?'resident':'management',updated_at:new Date().toISOString(),summary:{sensors:1,online:0,offline:1,never_seen:0,attention:0,needs_review:1,today_m3:0,month_m3:12,change_percent:null,open:1,acknowledged:0},series:[],attention:[],units:[]};
    }else if(path.endsWith('/ocorrencias'))body={items:[{id:'occ',title:'Sensor sem comunicação',serial:'090001',condominium_name:'Condomínio Teste',unit_identifier:'101',kind:'offline',status,opened_at:new Date().toISOString(),condition_active:true,resolution_note:status==='resolved'?'Conferido no local':null,can_operate:role==='admin',details:{minutes:30}}],summary:{open:status==='open'?1:0,acknowledged:status==='acknowledged'?1:0,resolved:status==='resolved'?1:0,total:1},last_evaluated_at:new Date().toISOString()};
    else if(path.endsWith('/acao')){status=route.request().postDataJSON().action==='resolve'?'resolved':'acknowledged';body={status};}
    await route.fulfill({json:body});
  });
  await page.goto('/?v2=1');
}
test('gestão distingue ausência de leitura e registra atendimento e resolução',async({page})=>{
  await setup(page);
  await expect(page.getByRole('heading',{name:'Visão da gestão'})).toBeVisible();
  await expect(page.getByText('Nenhuma leitura recebida no período.')).toBeVisible();
  await page.getByRole('button',{name:/1 abertas/}).click();
  await page.getByRole('button',{name:'Iniciar atendimento'}).click();
  await expect(page.getByText('Em atendimento',{exact:true}).last()).toBeVisible();
  await page.getByRole('button',{name:'Resolver',exact:true}).click();
  await expect(page.getByRole('button',{name:'Registrar resolução'})).toBeDisabled();
  await page.getByLabel('O que foi feito?').fill('Conferido no local');
  await page.getByRole('button',{name:'Registrar resolução'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText(/a condição ainda está presente/)).toBeVisible();
});
test('morador no celular tem painel próprio e consulta sem botões de operação',async({page})=>{
  await page.setViewportSize({width:390,height:844});await setup(page,'morador');
  await expect(page.getByRole('heading',{name:'Minha água'})).toBeVisible();
  await page.getByRole('button',{name:/1 abertas/}).click();
  await expect(page.getByRole('button',{name:'Histórico'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Resolver',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Regras',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('falha inicial apresenta erro sem cartões com zero inventado',async({page})=>{
  await setup(page,'admin',true);
  await expect(page.getByRole('alert')).toContainText('Falha de conexão');
  await expect(page.getByText('Consumo no mês',{exact:true})).toHaveCount(0);
});
