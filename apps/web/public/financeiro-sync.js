(()=>{
  'use strict';

  const session=(()=>{try{return JSON.parse(localStorage.getItem('hidrocondo.session')||'null')}catch{return null}})();
  if(!session?.token||session?.user?.role!=='superadmin')return;

  const headers=()=>({authorization:`Bearer ${session.token}`,'content-type':'application/json'});
  const show=(text,type='ok')=>{
    const e=document.querySelector('#alert');
    if(!e)return alert(text);
    e.className=`fin-alert show ${type}`;
    e.textContent=text;
    clearTimeout(show.t);
    show.t=setTimeout(()=>e.className='fin-alert',7000);
  };

  async function api(path,init={}){
    const r=await fetch(path,{...init,headers:{...headers(),...(init.headers||{})}});
    const b=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(b.error||`Erro ${r.status}`);
    return b;
  }

  function installBulkButton(){
    const section=document.querySelector('#clientes .fin-head');
    if(!section||document.querySelector('#syncAllAsaas'))return;
    const btn=document.createElement('button');
    btn.id='syncAllAsaas';
    btn.className='fin-btn primary';
    btn.textContent='Sincronizar todos com Asaas';
    btn.addEventListener('click',async()=>{
      if(!confirm('Sincronizar todos os clientes ainda não vinculados com o Asaas? Clientes sem CPF/CNPJ serão apenas sinalizados e não serão criados.'))return;
      const old=btn.textContent;btn.disabled=true;btn.textContent='Sincronizando...';
      try{
        const r=await api('/api/v1/financeiro/clientes/sincronizar-todos',{method:'POST',body:'{}'});
        show(`Concluído: ${r.created} criado(s), ${r.linked} vinculado(s), ${r.skipped} sem CPF/CNPJ, ${r.failed} falha(s).`,r.failed?'warn':'ok');
        setTimeout(()=>location.reload(),1800);
      }catch(e){show(e.message,'err');btn.disabled=false;btn.textContent=old;}
    });
    section.appendChild(btn);
  }

  // Intercepta o botão individual existente e usa a rota com reconciliação,
  // que procura primeiro por externalReference e CPF/CNPJ para não duplicar clientes.
  document.addEventListener('click',async e=>{
    const btn=e.target.closest?.('[data-sync]');
    if(!btn)return;
    e.preventDefault();e.stopImmediatePropagation();
    const id=btn.dataset.sync;
    if(!id)return;
    let body={};
    const row=btn.closest('tr');
    const hasMissingDoc=row?.textContent?.includes('CPF/CNPJ ausente');
    if(hasMissingDoc){
      const doc=prompt('Informe o CPF/CNPJ do responsável:');
      if(!doc)return;
      body.cpfCnpj=doc.replace(/\D/g,'');
    }
    const old=btn.textContent;btn.disabled=true;btn.textContent='Sincronizando...';
    try{
      const r=await api(`/api/v1/financeiro/clientes/${id}/asaas/reconciliar`,{method:'POST',body:JSON.stringify(body)});
      show(r.source==='created'?'Cliente criado no Asaas.':'Cliente localizado no Asaas e vinculado sem duplicar.');
      setTimeout(()=>location.reload(),900);
    }catch(err){show(err.message,'err');btn.disabled=false;btn.textContent=old;}
  },true);

  const observer=new MutationObserver(()=>installBulkButton());
  observer.observe(document.documentElement,{childList:true,subtree:true});
  installBulkButton();
})();
