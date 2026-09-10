(()=>{
  const ID='hidrocondo-financeiro-menu';
  function role(){try{return JSON.parse(localStorage.getItem('hidrocondo.session')||'{}')?.user?.role}catch{return null}}
  function install(){
    if(role()!=='superadmin'){document.getElementById(ID)?.remove();return;}
    const nav=document.querySelector('.v2-sidebar nav');
    if(!nav||document.getElementById(ID))return;
    const b=document.createElement('button');b.id=ID;b.type='button';b.title='Financeiro e cobranças';
    b.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>Financeiro';
    b.addEventListener('click',()=>location.href='/financeiro.html');nav.appendChild(b);
  }
  new MutationObserver(install).observe(document.documentElement,{subtree:true,childList:true});
  window.addEventListener('storage',install);setInterval(install,2000);install();
})();
