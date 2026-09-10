(()=>{
  'use strict';
  const session=(()=>{try{return JSON.parse(localStorage.getItem('hidrocondo.session')||'null')}catch{return null}})();
  if(!session?.token){location.href='/?v2=1';return;}
  if(session?.user?.role!=='superadmin'){document.body.innerHTML='<main style="font-family:system-ui;padding:40px"><h1>Acesso restrito</h1><p>O módulo Financeiro é exclusivo do Super Administrador.</p><p><a href="/?v2=1">Voltar ao HidroCondo</a></p></main>';return;}

  let plans=[],clients=[],charges=[];
  const $=s=>document.querySelector(s);
  const money=v=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const date=v=>v?new Date(`${String(v).slice(0,10)}T12:00:00`).toLocaleDateString('pt-BR'):'—';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const statusClass=v=>['RECEIVED','CONFIRMED','RECEIVED_IN_CASH','active','ready'].includes(v)?'ok':['OVERDUE','overdue'].includes(v)?'bad':['PENDING','draft','paused'].includes(v)?'warn':'off';
  const typeLabel=v=>({ONE_TIME:'Única',MONTHLY:'Mensal',QUARTERLY:'Trimestral',SEMIANNUALLY:'Semestral',YEARLY:'Anual',CUSTOM:'Personalizada'}[v]||v);
  const modelLabel=v=>({FIXED:'Fixo',PER_ACTIVE_SENSOR:'Base + sensor',TIERED:'Faixas'}[v]||v);
  const paymentLabel=v=>({UNDEFINED:'A definir',BOLETO:'Boleto',PIX:'Pix',CREDIT_CARD:'Cartão'}[v]||v);

  function alertMsg(text,type='ok'){const e=$('#alert');e.className=`fin-alert show ${type}`;e.textContent=text;clearTimeout(alertMsg.t);alertMsg.t=setTimeout(()=>e.className='fin-alert',5000)}
  async function api(path,init={}){
    const r=await fetch(path,{...init,headers:{authorization:`Bearer ${session.token}`,...(init.body?{'content-type':'application/json'}:{}),...(init.headers||{})}});
    if(r.status===401){localStorage.removeItem('hidrocondo.session');location.href='/?v2=1';throw new Error('Sessão expirada');}
    if(r.status===204)return null;
    const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||`Erro ${r.status}`);return b;
  }

  function nav(){document.querySelectorAll('.fin-nav button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.fin-nav button').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.fin-section').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.getElementById(b.dataset.section).classList.add('active')}));}
  function open(id){document.getElementById(id).classList.add('open')}
  function close(id){document.getElementById(id).classList.remove('open')}
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>close(b.dataset.close)));
  document.querySelectorAll('.fin-modal').forEach(m=>m.addEventListener('mousedown',e=>{if(e.target===m)close(m.id)}));

  async function loadAll(){try{[plans,clients,charges]=await Promise.all([api('/api/v1/financeiro/planos'),api('/api/v1/financeiro/clientes'),api('/api/v1/financeiro/cobrancas')]);renderPlans();renderClients();renderCharges();renderDashboard();await loadConfig()}catch(e){alertMsg(e.message,'err')}}
  async function loadConfig(){try{const c=await api('/api/v1/financeiro/configuracao');$('#cfgApi').textContent=c.asaas_configured?'Configurada':'Não configurada';$('#cfgApi').className=`fin-badge ${c.asaas_configured?'ok':'bad'}`;$('#cfgEnv').textContent=c.environment==='production'?'Produção':'Sandbox';$('#cfgWebhook').textContent=c.webhook_configured?'Configurado':'Não configurado';$('#cfgWebhook').className=`fin-badge ${c.webhook_configured?'ok':'bad'}`}catch(e){alertMsg(e.message,'err')}}

  function renderDashboard(){
    $('#kpiClientes').textContent=clients.length;$('#kpiAtivos').textContent=clients.filter(c=>['active','ready'].includes(c.billing_status)).length;$('#kpiOverdue').textContent=clients.filter(c=>c.billing_status==='overdue').length;$('#kpiPlanos').textContent=plans.filter(p=>p.active).length;
    const next=[...charges].filter(c=>!['RECEIVED','CONFIRMED','RECEIVED_IN_CASH','REFUNDED'].includes(c.status)).sort((a,b)=>String(a.due_date).localeCompare(String(b.due_date))).slice(0,8);
    $('#dashCharges').innerHTML=next.length?next.map(c=>`<tr><td>${esc(c.account_name)}</td><td>${esc(c.description||'Cobrança')}</td><td>${date(c.due_date)}</td><td>${money(c.amount)}</td><td><span class="fin-badge ${statusClass(c.status)}">${esc(c.status)}</span></td></tr>`).join(''):'<tr><td colspan="5" class="fin-empty">Nenhuma cobrança pendente.</td></tr>';
  }

  function renderPlans(){
    $('#plansTable').innerHTML=plans.length?plans.map(p=>`<tr><td><strong>${esc(p.name)}</strong><div class="fin-muted">${esc(p.description||'')}</div></td><td>${typeLabel(p.billing_type)}</td><td>${modelLabel(p.pricing_model)}</td><td>${p.pricing_model==='PER_ACTIVE_SENSOR'?`${money(p.amount)} + ${money(p.unit_amount)}/sensor`:money(p.amount)}</td><td><span class="fin-badge ${p.active?'ok':'off'}">${p.active?'Ativo':'Inativo'}</span></td><td><button class="fin-btn secondary" data-edit-plan="${p.id}">Editar</button></td></tr>`).join(''):'<tr><td colspan="6" class="fin-empty">Nenhum plano cadastrado.</td></tr>';
    document.querySelectorAll('[data-edit-plan]').forEach(b=>b.addEventListener('click',()=>editPlan(b.dataset.editPlan)));
    fillPlanSelect();
  }
  function fillPlanSelect(){const active=plans.filter(p=>p.active);$('#subPlan').innerHTML=active.map(p=>`<option value="${p.id}">${esc(p.name)} — ${typeLabel(p.billing_type)}</option>`).join('')}
  function editPlan(id){const p=plans.find(x=>x.id===id);if(!p)return;$('#planModalTitle').textContent='Editar plano';$('#planId').value=p.id;$('#planName').value=p.name;$('#planDescription').value=p.description||'';$('#planType').value=p.billing_type;$('#pricingModel').value=p.pricing_model;$('#planAmount').value=p.amount;$('#planUnitAmount').value=p.unit_amount??'';$('#planActive').checked=!!p.active;$('#planTiers').value=(p.tiers||[]).map(t=>`${t.min_units},${t.max_units??''},${t.amount}`).join('\n');toggleTier();open('planModal')}
  function newPlan(){$('#planModalTitle').textContent='Novo plano';$('#planId').value='';$('#planName').value='';$('#planDescription').value='';$('#planType').value='MONTHLY';$('#pricingModel').value='FIXED';$('#planAmount').value='0';$('#planUnitAmount').value='';$('#planActive').checked=true;$('#planTiers').value='';toggleTier();open('planModal')}
  function toggleTier(){const m=$('#pricingModel').value;$('#tiersWrap').style.display=m==='TIERED'?'grid':'none';$('#planUnitAmount').closest('label').style.display=m==='PER_ACTIVE_SENSOR'?'grid':'none'}
  function parseTiers(){return $('#planTiers').value.split(/\n+/).map(x=>x.trim()).filter(Boolean).map(line=>{const [a,b,c]=line.split(',').map(x=>x.trim());if(a===''||c==='')throw new Error(`Faixa inválida: ${line}`);return{min_units:Number(a),max_units:b===''?null:Number(b),amount:Number(c.replace(',','.'))}})}

  function renderClients(){
    $('#clientsTable').innerHTML=clients.length?clients.map(c=>`<tr><td><strong>${esc(c.name)}</strong><div class="fin-muted">${esc(c.id)}</div></td><td>${esc(c.owner_name||'—')}<div class="fin-muted">${esc(c.owner_email||'')}</div></td><td>${Number(c.active_sensors||0)}</td><td>${c.asaas_customer_id?'<span class="fin-badge ok">Vinculado</span>':'<span class="fin-badge off">Não vinculado</span>'}</td><td>${esc(c.plan_name||'Sem plano')}<div class="fin-muted">${esc(c.subscription_status||'')}</div></td><td><span class="fin-badge ${statusClass(c.billing_status)}">${esc(c.billing_status||'inactive')}</span></td><td><div class="fin-actions">${!c.asaas_customer_id?`<button class="fin-btn secondary" data-sync="${c.id}">Vincular Asaas</button>`:''}<button class="fin-btn primary" data-sub="${c.id}">Definir plano</button></div></td></tr>`).join(''):'<tr><td colspan="7" class="fin-empty">Nenhuma conta de cliente encontrada.</td></tr>';
    document.querySelectorAll('[data-sync]').forEach(b=>b.addEventListener('click',()=>syncClient(b.dataset.sync)));
    document.querySelectorAll('[data-sub]').forEach(b=>b.addEventListener('click',()=>openSubscription(b.dataset.sub)));
    $('#chargeAccount').innerHTML=clients.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  async function syncClient(id){const c=clients.find(x=>x.id===id);if(!c)return;let body={};if(!c.owner_document){const doc=prompt(`Informe o CPF/CNPJ do responsável por ${c.name}:`);if(!doc)return;body.cpfCnpj=doc.replace(/\D/g,'')}try{await api(`/api/v1/financeiro/clientes/${id}/asaas`,{method:'POST',body:JSON.stringify(body)});alertMsg('Cliente vinculado ao Asaas.');await loadAll()}catch(e){alertMsg(e.message,'err')}}
  function openSubscription(id){if(!plans.filter(p=>p.active).length){alertMsg('Cadastre um plano ativo primeiro.','err');return}$('#subAccountId').value=id;$('#subStart').value=new Date().toISOString().slice(0,10);$('#subPayment').value='UNDEFINED';$('#subCustomAmount').value='';$('#subDueDay').value='';$('#subDiscountType').value='';$('#subDiscountValue').value='';$('#subDiscountUntil').value='';$('#subSuspendAfter').value='30';$('#subSync').checked=true;fillPlanSelect();open('subscriptionModal')}

  function renderCharges(){
    $('#chargesTable').innerHTML=charges.length?charges.map(c=>`<tr><td>${esc(c.account_name)}</td><td>${esc(c.description||'Cobrança')}</td><td>${date(c.due_date)}</td><td>${money(c.amount)}</td><td>${paymentLabel(c.payment_method)}</td><td><span class="fin-badge ${statusClass(c.status)}">${esc(c.status)}</span></td><td>${c.invoice_url?`<a href="${esc(c.invoice_url)}" target="_blank" rel="noopener">Abrir</a>`:'—'}</td></tr>`).join(''):'<tr><td colspan="7" class="fin-empty">Nenhuma cobrança registrada.</td></tr>';
  }

  $('#newPlan').addEventListener('click',newPlan);$('#pricingModel').addEventListener('change',toggleTier);$('#refreshAll').addEventListener('click',loadAll);
  $('#newCharge').addEventListener('click',()=>{if(!clients.length){alertMsg('Cadastre um cliente primeiro.','err');return}$('#chargeDescription').value='';$('#chargeAmount').value='';$('#chargeDue').value=new Date().toISOString().slice(0,10);$('#chargePayment').value='UNDEFINED';$('#chargeSync').checked=true;open('chargeModal')});

  $('#planForm').addEventListener('submit',async e=>{e.preventDefault();try{const id=$('#planId').value;const model=$('#pricingModel').value;const body={name:$('#planName').value.trim(),description:$('#planDescription').value.trim()||null,billing_type:$('#planType').value,pricing_model:model,amount:Number($('#planAmount').value||0),unit_amount:model==='PER_ACTIVE_SENSOR'?Number($('#planUnitAmount').value||0):null,active:$('#planActive').checked,tiers:model==='TIERED'?parseTiers():[]};if(id)await api(`/api/v1/financeiro/planos/${id}`,{method:'PUT',body:JSON.stringify(body)});else{delete body.active;await api('/api/v1/financeiro/planos',{method:'POST',body:JSON.stringify(body)})}close('planModal');alertMsg('Plano salvo.');await loadAll()}catch(x){alertMsg(x.message,'err')}});

  $('#subscriptionForm').addEventListener('submit',async e=>{e.preventDefault();try{const plan=plans.find(p=>p.id===$('#subPlan').value);if($('#subSync').checked&&plan?.billing_type==='ONE_TIME')throw new Error('Plano de cobrança única deve ser lançado em Cobranças, não como assinatura.');const body={account_id:$('#subAccountId').value,plan_id:$('#subPlan').value,payment_method:$('#subPayment').value,start_date:$('#subStart').value,due_day:$('#subDueDay').value?Number($('#subDueDay').value):undefined,custom_amount:$('#subCustomAmount').value?Number($('#subCustomAmount').value):null,discount_type:$('#subDiscountType').value||null,discount_value:$('#subDiscountValue').value?Number($('#subDiscountValue').value):null,discount_until:$('#subDiscountUntil').value||null,suspend_after_days:$('#subSuspendAfter').value?Number($('#subSuspendAfter').value):null,sync_asaas:$('#subSync').checked};await api('/api/v1/financeiro/assinaturas',{method:'POST',body:JSON.stringify(body)});close('subscriptionModal');alertMsg('Cobrança do cliente configurada.');await loadAll()}catch(x){alertMsg(x.message,'err')}});

  $('#chargeForm').addEventListener('submit',async e=>{e.preventDefault();try{const body={account_id:$('#chargeAccount').value,description:$('#chargeDescription').value.trim(),amount:Number($('#chargeAmount').value),due_date:$('#chargeDue').value,payment_method:$('#chargePayment').value,sync_asaas:$('#chargeSync').checked};await api('/api/v1/financeiro/cobrancas',{method:'POST',body:JSON.stringify(body)});close('chargeModal');alertMsg('Cobrança criada.');await loadAll()}catch(x){alertMsg(x.message,'err')}});

  nav();toggleTier();loadAll();
})();
