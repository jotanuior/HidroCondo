import {test,expect,type Page} from '@playwright/test';
const sensor={id:'sensor-1',sensor_id:'sensor-1',serial:'090011000002',sensor_type:'09',central_serial:'central-1',active:true,account_id:'account-1',account_name:'Conta Original',owner_user_id:'owner-1',owner_name:'Proprietário Original',responsible_user_id:null,responsible_name:null,unit_id:'unit-1',unit_identifier:'101',resident_name:'Responsável Unidade',building_name:'Bloco A',condominium_name:'Condomínio Teste',last_seen_at:new Date().toISOString(),last_reading_at:new Date().toISOString(),claimed_at:null,claimed_by_name:null,created_at:new Date().toISOString(),conversion_factor:0.001,counter_digits:6,max_flow_m3_hour:null,last_raw_value:7,virtual_counter:1,needs_review:false,connection_status:'online'};
async function open(page:Page,role:string){
  await page.addInitScript(role=>localStorage.setItem('hidrocondo.session',JSON.stringify({token:'test',user:{id:'user-1',name:'Admin Teste',email:'admin@test.local',role}})),role);
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/conta')&&route.request().method()==='POST')return route.fulfill({json:{ok:true}});
    let body:unknown=[];
    if(path==='/api/v1/sensores')body=[sensor];
    if(path.endsWith('/ficha'))body={sensor,users:[{id:'user-1',name:'Admin Teste',email:'admin@test.local',role:'admin',active:true}],audit:[{id:'1',created_at:new Date().toISOString(),action:'sensor_responsible_changed',actor_name:'Autor Original',actor_role:'admin',payload:{before:{responsible_user_id:null},after:{responsible_user_id:'user-1'},reason:'Conferência'}}],permissions:{manage:true,transfer_account:role==='superadmin',change_owner:true,manage_unit:true}};
    if(path==='/api/v1/gestao/contas')body=[{id:'account-1',name:'Conta Original',owner_name:'Proprietário Original'},{id:'account-2',name:'Conta Destino',owner_name:'Novo Proprietário'}];
    if(path==='/api/v1/dashboard/operacional')return route.fulfill({status:500,json:{error:'Dashboard fora deste teste'}});
    return route.fulfill({json:body});
  });
  await page.goto('/?v2=1');await page.getByRole('button',{name:'Sensores',exact:true}).click();await page.getByRole('button',{name:sensor.serial,exact:true}).click();
}
test('serial abre ficha completa; administrador vê vínculos e auditoria',async({page})=>{
  await open(page,'admin');
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Conta Original',{exact:true})).toBeVisible();await expect(dialog.getByText('Proprietário Original',{exact:true})).toBeVisible();
  await expect(dialog.getByText('Responsável Unidade',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Usuários e vínculos'}).click();
  await expect(dialog.getByRole('button',{name:'Trocar responsável pelo sensor'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Transferir para outra conta'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Auditoria',exact:true}).click();await expect(dialog.getByText(/Autor Original/)).toBeVisible();
  await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
});
test('superadmin transfere com destino explícito e justificativa',async({page})=>{
  await open(page,'superadmin');const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Usuários e vínculos'}).click();await dialog.getByRole('button',{name:'Transferir para outra conta'}).click();
  await expect(dialog.getByText(/encerra a instalação atual/)).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Confirmar alteração'})).toBeDisabled();
  await dialog.getByLabel('Conta',{exact:true}).selectOption('account-2');await dialog.getByLabel('Justificativa').fill('Transferência conferida pelo proprietário');
  const pending=page.waitForRequest(r=>r.url().endsWith('/sensor-1/conta')&&r.method()==='POST');
  await dialog.getByRole('button',{name:'Confirmar alteração'}).click();
  expect((await pending).postDataJSON()).toEqual({account_id:'account-2',expected_account_id:'account-1',reason:'Transferência conferida pelo proprietário'});
  await expect(dialog.getByText('Alteração registrada no histórico.')).toBeVisible();
});
