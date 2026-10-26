// Agenda Escolar: interface. Roda no navegador como módulo (sem scripts embutidos, por causa da CSP).
// Toda decisão de segurança é do servidor (cookie de sessão HttpOnly). Aqui só ficam interface e sincronização.
import { TIPOS, isAvaliativo, buildDigest, digestMessage, fmtDia, NOME_FRASE } from './digest.js';
import { initUploads } from './uploads.js';

const MESES=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const MES3=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const DIAS=['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
const DIA3=['dom','seg','ter','qua','qui','sex','sáb'];
const MATERIAS=['Matemática','Português','História','Geografia','Ciências','Inglês','Física','Química','Biologia','Artes','Educação Física','Redação'];
const LS_KEY='agenda-escolar-v1';        // dados antigos (antes das contas), só para importar uma vez
const JANELA=10;
const CHUNK=400;                          // itens por pedido de sincronização (limite do servidor: 1000)
const K_LOCAL='agenda-avisos-local', K_DISMISS='agenda-avisos-dispensado', K_LAST='agenda-ultimo-aviso';

const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
const p2=n=>String(n).padStart(2,'0');
const iso=d=>d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
const parse=s=>{const a=s.split('-').map(Number);return new Date(a[0],a[1]-1,a[2]);};
const addDays=(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const today=()=>iso(new Date());
const dayDiff=(a,b)=>Math.round((parse(a)-parse(b))/864e5);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtShort=s=>{const d=parse(s);return DIA3[d.getDay()]+', '+d.getDate()+' '+MES3[d.getMonth()];};
const plural=(n,a,b)=>n+' '+(n===1?a:b);
const ISO_RE=/^\d{4}-\d{2}-\d{2}$/;
const lsGet=k=>{try{return localStorage.getItem(k);}catch(e){return null;}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v);}catch(e){}};
const lsDel=k=>{try{localStorage.removeItem(k);}catch(e){}};
const ssGet=k=>{try{return sessionStorage.getItem(k);}catch(e){return null;}};
const ssSet=(k,v)=>{try{sessionStorage.setItem(k,v);}catch(e){}};

/* Prazo: vermelho até 3 dias (inclui atrasadas), âmbar 4 a 6, azul 7 a 10 */
const urg=d=>d<=3?'red':d<=6?'yel':d<=JANELA?'blue':'far';
const relText=d=>d<0?'atrasada há '+plural(-d,'dia','dias'):d===0?'hoje':d===1?'amanhã':'em '+d+' dias';
const TIPO_DIA={tarefa:'Dia da entrega',entrega:'Dia da entrega',prova:'Dia da prova',teste:'Dia do teste',apresentacao:'Dia da apresentação',seminario:'Dia do seminário'};

/* ---------- Comunicação com o servidor ---------- */
const MSG={
  invalid_credentials:'E-mail ou senha incorretos.',
  rate_limited:'Muitas tentativas. Espere um pouco e tente de novo.',
  invalid_email:'Digite um e-mail válido.',
  password_too_short:'A senha precisa ter pelo menos 10 caracteres.',
  password_too_long:'A senha pode ter no máximo 128 caracteres.',
  password_too_common:'Essa senha é muito comum. Escolha outra, de preferência uma frase longa.',
  password_same_as_email:'A senha não pode ser igual nem parecida com o seu e-mail.',
  invalid_password:'Senha inválida.',
  terms_required:'Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.',
  age_required:'Para criar a conta, confirme a declaração de idade.',
  account_unavailable:'Não foi possível criar a conta com esses dados. Se você já tem conta, entre ou recupere a senha.',
  registration_closed:'Novos cadastros estão fechados no momento.',
  invalid_recovery:'E-mail ou código de recuperação inválido (ou já usado).',
  invalid_reset:'Link inválido ou expirado. Peça um novo.',
  invalid_code:'Código do app autenticador incorreto.',
  mfa_required:'Digite o código do seu app autenticador.',
  wrong_password:'Senha incorreta.',
  confirmation_required:'Digite EXCLUIR para confirmar.',
  forbidden_origin:'Pedido bloqueado por segurança. Recarregue a página e tente de novo.',
  payload_too_large:'Dados grandes demais.',
  server_misconfigured:'O servidor ainda não foi configurado pelo responsável do site.',
  internal:'Algo deu errado no servidor. Tente de novo em instantes.',
  network:'Sem conexão com o servidor. Verifique a internet e tente de novo.',
  limit_exceeded:'Você chegou ao limite de atividades ou matérias da conta.',
  too_many_devices:'Você já tem aparelhos demais com avisos ativos.',
  push_not_configured:'Os avisos com o app fechado ainda não foram configurados neste site.',
  totp_already_enabled:'A verificação em duas etapas já está ativa.',
  totp_not_enabled:'A verificação em duas etapas não está ativa.',
  totp_not_pending:'Comece de novo a ativação da verificação em duas etapas.',
  unauthenticated:'Sua sessão expirou. Entre novamente.',
};
class ApiError extends Error{constructor(status,code,retry){super(code);this.status=status;this.code=code;this.retry=retry;}}
const fmtWait=s=>{s=Number(s)||0;return s>=3600?Math.ceil(s/3600)+' h':s>=60?Math.ceil(s/60)+' min':Math.max(1,s)+' s';};
const errMsg=e=>(e&&e.code==='rate_limited'&&e.retry)?'Muitas tentativas. Tente de novo em '+fmtWait(e.retry)+'.':(MSG[e&&e.code]||'Não foi possível concluir. Tente de novo.');

let cfg={}, me=null;
async function api(method,path,body){
  let res;
  try{
    res=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:body!==undefined?{'Content-Type':'application/json'}:{},body:body!==undefined?JSON.stringify(body):undefined});
  }catch(e){throw new ApiError(0,'network');}
  let data=null;try{data=await res.json();}catch(e){}
  if(!res.ok){
    const err=new ApiError(res.status,(data&&data.error)||'internal',res.headers.get('Retry-After'));
    if(res.status===401&&err.code==='unauthenticated'&&me)sessionExpired();
    throw err;
  }
  return data;
}

/* ---------- Estado e sincronização ---------- */
let state={v:1,items:[],materias:[]};
// Anexos (cesta de basquete). Módulo à parte: aqui só o ligamos ao que o app já tem.
const UP=initUploads({getItems:()=>state.items,onFilesChange:()=>renderAll(),flushSync:()=>flush(),sessionExpired:()=>sessionExpired(),toast:m=>toast(m)});
UP.mount($('#up-nova'));UP.mount($('#up-dist'),'materia');
const view={tab:'semana',weekStart:addDays(new Date(),-new Date().getDay()),year:new Date().getFullYear(),sel:today(),rf:'tudo',q:'',confirmDel:null,open:new Set()};

function normalize(d){
  const items=(Array.isArray(d&&d.items)?d.items:[]).filter(i=>i&&!i.ex&&typeof i.titulo==='string'&&typeof i.data==='string'&&ISO_RE.test(i.data)).map(i=>{
    const o={id:String(i.id),titulo:i.titulo,materia:String(i.materia||'Geral'),tipo:TIPOS[i.tipo]?i.tipo:'tarefa',data:i.data,obs:String(i.obs||''),feita:!!i.feita};
    if(o.feita)o.feitaEm=(typeof i.feitaEm==='string'&&ISO_RE.test(i.feitaEm))?i.feitaEm:i.data;
    if(i.comp)o.comp=String(i.comp);
    return o;
  });
  const materias=(Array.isArray(d&&d.materias)?d.materias:[]).filter(m=>m&&typeof m.nome==='string'&&Array.isArray(m.comps)).map(m=>({
    id:String(m.id||'m'+Math.random().toString(36).slice(2,7)),
    nome:m.nome,
    comps:m.comps.filter(c=>c&&typeof c.nome==='string'&&isFinite(Number(c.max))&&Number(c.max)>0).map(c=>{
      const max=Number(c.max);
      const t=(c.tirei===null||c.tirei===undefined||c.tirei==='')?null:Math.min(Math.max(Number(c.tirei)||0,0),max);
      return {id:String(c.id),nome:c.nome,max:max,tirei:t};
    })
  }));
  return {v:1,items,materias};
}

function change(fn){fn();persist();renderAll();}
const byId=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
const canon=s=>JSON.stringify({i:[...s.items].sort(byId),m:[...s.materias].sort(byId)});
const snap=s=>({items:new Map(s.items.map(i=>[i.id,JSON.stringify(i)])),mats:new Map(s.materias.map(m=>[m.id,JSON.stringify(m)]))});
let base=snap(state), rev=0, saveTimer=null, saving=false, retryT=null;

function setStatus(k){
  const el=$('#status');
  const m={saving:['Salvando…',false],saved:['Salvo na sua conta',false],error:['Sem conexão. Vou tentar de novo…',true],wait:['',false]};
  const v=m[k]||m.wait;el.textContent=v[0];el.classList.toggle('warn',v[1]);
}
const emptyOps=()=>({items:{upsert:[],delete:[]},materias:{upsert:[],delete:[]}});
const opsEmpty=o=>!(o.items.upsert.length||o.items.delete.length||o.materias.upsert.length||o.materias.delete.length);
function buildOps(){
  const cur=snap(state),ops=emptyOps();
  state.items.forEach(i=>{if(base.items.get(i.id)!==cur.items.get(i.id))ops.items.upsert.push(JSON.parse(JSON.stringify(i)));});
  base.items.forEach((_,id)=>{if(!cur.items.has(id))ops.items.delete.push(id);});
  state.materias.forEach(m=>{if(base.mats.get(m.id)!==cur.mats.get(m.id))ops.materias.upsert.push(JSON.parse(JSON.stringify(m)));});
  base.mats.forEach((_,id)=>{if(!cur.mats.has(id))ops.materias.delete.push(id);});
  return ops;
}
const pendingOps=()=>!!me&&!opsEmpty(buildOps());
function takeChunk(ops){const out=emptyOps();for(const s of ['items','materias'])for(const k of ['upsert','delete'])out[s][k]=ops[s][k].splice(0,CHUNK);return out;}
function applyToBase(p){
  p.items.upsert.forEach(i=>base.items.set(i.id,JSON.stringify(i)));p.items.delete.forEach(id=>base.items.delete(id));
  p.materias.upsert.forEach(m=>base.mats.set(m.id,JSON.stringify(m)));p.materias.delete.forEach(id=>base.mats.delete(id));
}
function adopt(r){
  const n=normalize(r);
  if(canon(n)!==canon(state)){state=n;renderAll();}
  base=snap(state);rev=r.rev;
}
async function loadState(){const r=await api('GET','/api/sync');adopt(r);setStatus('saved');}
async function refresh(){
  if(!me||saving||saveTimer||pendingOps())return;
  try{const r=await api('GET','/api/sync');if(r.rev!==rev&&!saving&&!saveTimer&&!pendingOps())adopt(r);}catch(e){}
}
function persist(){
  if(!me)return;
  setStatus('saving');clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;flush();},400);
}
async function flush(){
  if(!me)return true;
  if(saving){return false;}
  clearTimeout(saveTimer);saveTimer=null;clearTimeout(retryT);
  saving=true;let ok=true;
  try{
    for(;;){
      const rest=buildOps();
      if(opsEmpty(rest))break;
      let r=null;
      while(!opsEmpty(rest)){const part=takeChunk(rest);r=await api('POST','/api/sync',part);applyToBase(part);}
      rev=r.rev;
      if(opsEmpty(buildOps()))adopt(r);   // nada mudou durante o envio: adota o que o servidor tem (inclui outros aparelhos)
    }
    setStatus('saved');
  }catch(e){
    ok=false;
    if(!me||e.status===401){/* a sessão expirou: sessionExpired() já cuidou */}
    else if(e.status===429){setStatus('error');retryT=setTimeout(flush,Math.min(60,Number(e.retry)||10)*1000);}
    else if(e.status>=400&&e.status<500){   // o servidor recusou a alteração: volta ao que está salvo para não repetir o erro
      toast(e.code==='limit_exceeded'?MSG.limit_exceeded:'Não foi possível salvar essa alteração.');
      try{const r=await api('GET','/api/sync');state=normalize(r);base=snap(state);rev=r.rev;renderAll();setStatus('saved');}catch(e2){setStatus('error');}
    }else{setStatus('error');retryT=setTimeout(flush,8000);}
  }finally{saving=false;}
  return ok;
}
window.addEventListener('online',()=>{if(me)flush();});
window.addEventListener('beforeunload',e=>{if(pendingOps()||saveTimer){e.preventDefault();e.returnValue='';}});

/* ---------- Dados derivados ---------- */
const pend=()=>state.items.filter(i=>!i.feita);
function byDate(){const o={};pend().forEach(i=>{(o[i.data]=o[i.data]||[]).push(i);});return o;}
const cmp=(a,b)=>(isAvaliativo(b.tipo)-isAvaliativo(a.tipo))||a.titulo.localeCompare(b.titulo,'pt-BR');
function avisos(){
  const t=today();
  return pend().map(i=>({i,d:dayDiff(i.data,t)})).filter(x=>x.d<=JANELA).sort((a,b)=>a.d-b.d||cmp(a.i,b.i));
}

/* ---------- Peças de HTML ---------- */
function itemHTML(i,o){
  o=o||{};const d=dayDiff(i.data,today());
  let sub='';
  if(o.date)sub+='<span>'+fmtShort(i.data)+'</span>';
  if(o.rel)sub+='<span class="rel '+urg(d)+'">'+relText(d)+'</span>';
  if(o.done)sub+='<span>feita em '+fmtShort(i.feitaEm||i.data)+'</span>';
  const cn=compNameOf(i);if(cn)sub+='<span>nota: '+esc(cn)+'</span>';
  sub+=UP.chip(i.id);
  const confirm=view.confirmDel===i.id;
  return '<li class="item'+(i.feita?' feita':'')+'">'+
    '<button type="button" class="check" role="checkbox" aria-checked="'+(i.feita?'true':'false')+'" aria-label="'+(i.feita?'Voltar para pendentes':'Marcar como feita')+': '+esc(i.titulo)+'" data-action="toggle" data-id="'+esc(i.id)+'"></button>'+
    '<div class="txt"><span class="titulo">'+esc(i.titulo)+'</span>'+
    '<span class="meta"><span class="chip '+i.tipo+'">'+TIPOS[i.tipo]+'</span><span>'+esc(i.materia)+'</span>'+sub+'</span>'+
    (i.obs?'<span class="obs">'+esc(i.obs)+'</span>':'')+'</div>'+
    (o.del?'<button type="button" class="del'+(confirm?' sure':'')+'" data-action="del" data-id="'+esc(i.id)+'">'+(confirm?'Apagar mesmo?':'Apagar')+'</button>':'')+
    '</li>';
}
function rangeText(ws){
  const e=addDays(ws,6);
  if(ws.getMonth()===e.getMonth())return ws.getDate()+' a '+e.getDate()+' de '+MESES[e.getMonth()]+' de '+e.getFullYear();
  return ws.getDate()+' de '+MES3[ws.getMonth()]+' a '+e.getDate()+' de '+MES3[e.getMonth()]+' de '+e.getFullYear();
}

/* ---------- Renderização ---------- */
function renderTop(){
  const n=new Date();
  $('#hojeTxt').textContent=DIAS[n.getDay()]+', '+n.getDate()+' de '+MESES[n.getMonth()]+' de '+n.getFullYear();
  $('#vazio').hidden=state.items.length>0;
  const nf=state.items.filter(i=>i.feita).length,b=$('#n-feitas');
  b.textContent=nf;b.hidden=!nf;
}
function renderAvisos(){
  const list=avisos();
  $('#av-count').textContent=list.length;$('#av-count').hidden=!list.length;
  if(!list.length){
    $('#avList').innerHTML='<li class="av-vazio">'+(state.items.length?'Nenhum prazo nos próximos '+JANELA+' dias.':'Quando você anotar atividades, os prazos próximos aparecem aqui.')+'</li>';
    return;
  }
  $('#avList').innerHTML=list.map(x=>{
    const d=x.d,i=x.i,u=urg(d);
    const tag=d<0?'Atrasada há '+plural(-d,'dia','dias'):d===0?'Hoje':d===1?'Amanhã':'Em '+d+' dias';
    return '<li class="av"><span class="pill '+u+'">'+tag+'</span><div class="av-txt"><strong>'+esc(i.titulo)+'</strong><span>'+TIPOS[i.tipo]+' · '+esc(i.materia)+' · '+fmtShort(i.data)+'</span></div>'+
      '<button type="button" class="ghost" data-action="toggle" data-id="'+esc(i.id)+'" aria-label="Marcar como feita: '+esc(i.titulo)+'">Feita</button></li>';
  }).join('');
}
function renderSemana(){
  const t=today(),by=byDate(),ws=view.weekStart;
  let n=0,p=0,h='';
  for(let k=0;k<7;k++){
    const d=addDays(ws,k),s=iso(d),list=(by[s]||[]).slice().sort(cmp);
    n+=list.length;p+=list.filter(i=>isAvaliativo(i.tipo)).length;
    h+='<section class="dia'+(s===t?' hoje':'')+'" aria-label="'+DIAS[d.getDay()]+', '+d.getDate()+' de '+MESES[d.getMonth()]+'">'+
      '<div class="dia-h"><span class="dow">'+DIA3[d.getDay()]+'</span><span class="num">'+d.getDate()+'</span>'+(s===t?'<span class="hojetag">hoje</span>':'')+'</div>'+
      '<div class="dia-b">'+(list.length?'<ul class="itens">'+list.map(i=>itemHTML(i)).join('')+'</ul>':'<p class="livre">Livre</p>')+
      '<button type="button" class="add" data-action="add-day" data-date="'+s+'">+ anotar</button></div></section>';
  }
  $('#semana-grid').innerHTML=h;
  $('#semana-range').textContent=rangeText(ws);
  $('#semana-sum').textContent=n?plural(n,'atividade a fazer','atividades a fazer')+(p?' · '+plural(p,'data importante','datas importantes'):''):'Nada a fazer nesta semana.';
}
function renderCal(){
  const t=today(),by=byDate(),y=view.year;let h='';
  $('#cal-ano').textContent=y;
  for(let m=0;m<12;m++){
    const lead=new Date(y,m,1).getDay(),nd=new Date(y,m+1,0).getDate();
    h+='<section class="mes"><h3>'+MESES[m]+'</h3><div class="grade">';
    ['D','S','T','Q','Q','S','S'].forEach(w=>{h+='<span class="wd" aria-hidden="true">'+w+'</span>';});
    for(let k=0;k<lead;k++)h+='<span></span>';
    for(let d=1;d<=nd;d++){
      const s=y+'-'+p2(m+1)+'-'+p2(d),l=by[s]||[];let c='d';
      if(l.length){c+=' u-'+urg(dayDiff(s,t));if(l.some(i=>isAvaliativo(i.tipo)))c+=' aval';}
      if(s===t)c+=' hoje';
      if(s===view.sel)c+=' sel';
      h+='<button type="button" class="'+c+'" data-action="cal-sel" data-date="'+s+'" aria-pressed="'+(s===view.sel?'true':'false')+'" aria-label="'+d+' de '+MESES[m]+(l.length?', '+plural(l.length,'atividade','atividades'):'')+'">'+d+'</button>';
    }
    h+='</div></section>';
  }
  $('#cal-meses').innerHTML=h;
  const sd=parse(view.sel),sl=(by[view.sel]||[]).slice().sort(cmp);
  $('#cal-sel-t').textContent=DIAS[sd.getDay()]+', '+sd.getDate()+' de '+MESES[sd.getMonth()]+' de '+sd.getFullYear();
  $('#cal-sel-l').innerHTML=sl.length?'<ul class="itens">'+sl.map(i=>itemHTML(i)).join('')+'</ul>':'<p class="livre">Nada a fazer neste dia.</p>';
  $('#cal-add').dataset.date=view.sel;
  const nx=pend().sort((a,b)=>a.data.localeCompare(b.data)||cmp(a,b)).slice(0,6);
  $('#cal-next').innerHTML=nx.length?'<ul class="itens">'+nx.map(i=>itemHTML(i,{date:true,rel:true})).join('')+'</ul>':'<p class="livre">Nada pendente pela frente.</p>';
}
function groupBars(items,keyFn,labelFn){
  const g={};
  items.forEach(i=>{const k=keyFn(i);(g[k]=g[k]||{label:labelFn(i),t:0,f:0});g[k].t++;if(i.feita)g[k].f++;});
  const arr=Object.keys(g).map(k=>g[k]).sort((a,b)=>b.t-a.t||a.label.localeCompare(b.label,'pt-BR'));
  if(!arr.length)return '<li class="livre">Sem atividades neste período.</li>';
  return arr.map(x=>{
    const pc=Math.round(x.f/x.t*100);
    return '<li><div class="bar-top"><span>'+esc(x.label)+'</span><span class="mono">'+x.f+' de '+x.t+' · '+pc+'%</span></div>'+
      '<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pc+'" aria-label="'+esc(x.label)+'"><div class="fill" data-w="'+pc+'"></div></div></li>';
  }).join('');
}
function renderRend(){
  const t=today();let items=state.items;
  if(view.rf==='semana'){const ws=iso(addDays(new Date(),-new Date().getDay())),we=iso(addDays(parse(ws),6));items=items.filter(i=>i.data>=ws&&i.data<=we);}
  else if(view.rf==='mes'){const pre=t.slice(0,7);items=items.filter(i=>i.data.slice(0,7)===pre);}
  const total=items.length,feitas=items.filter(i=>i.feita).length;
  const atras=items.filter(i=>!i.feita&&i.data<t).length,pen=items.filter(i=>!i.feita&&i.data>=t).length;
  const pc=total?Math.round(feitas/total*100):0;
  const C=2*Math.PI*52;
  let col='var(--teal)',titulo='Ótimo ritmo',msg='Você está em dia com quase tudo.';
  if(!total){col='var(--line)';titulo='Sem dados ainda';msg='Anote atividades para ver seu aproveitamento.';}
  else if(pc<50){col='var(--red)';titulo='Tem coisa acumulada';msg=atras?'Comece pelas '+plural(atras,'atrasada','atrasadas')+'.':'Vá marcando o que concluir.';}
  else if(pc<80){col='#A86800';titulo='Bom, dá para melhorar';msg=atras?'Ainda há '+plural(atras,'atividade atrasada','atividades atrasadas')+'.':'Falta pouco para fechar o período.';}
  else if(atras){msg='Só '+plural(atras,'atividade atrasada','atividades atrasadas')+' para resolver.';}
  $('#rend-ring').innerHTML='<svg class="ring" viewBox="0 0 120 120" role="img" aria-label="Aproveitamento de '+pc+' por cento">'+
    '<circle class="bg" cx="60" cy="60" r="52"/>'+
    '<circle class="fg" cx="60" cy="60" r="52" stroke="'+col+'" stroke-dasharray="'+C.toFixed(2)+'" stroke-dashoffset="'+(C*(1-pc/100)).toFixed(2)+'" transform="rotate(-90 60 60)"/>'+
    '<text x="60" y="69">'+(total?pc+'%':'—')+'</text></svg>'+
    '<div class="ring-msg"><strong>'+titulo+'</strong><p>'+msg+'</p></div>';
  $('#rend-nums').innerHTML='<div class="f"><b>'+feitas+'</b><span>Feitas</span></div><div><b>'+pen+'</b><span>No prazo</span></div><div class="l"><b>'+atras+'</b><span>Atrasadas</span></div>';
  $('#rend-mat').innerHTML=groupBars(items,i=>i.materia.trim().toLowerCase(),i=>i.materia);
  $('#rend-tipo').innerHTML=groupBars(items,i=>i.tipo,i=>TIPOS[i.tipo]);
  document.querySelectorAll('[data-action="rend-f"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===view.rf)));
}
function renderLista(){
  const items=pend().sort((a,b)=>a.data.localeCompare(b.data)||cmp(a,b));
  $('#lista').innerHTML=items.length?'<ul class="itens">'+items.map(i=>itemHTML(i,{date:true,rel:true,del:true})).join('')+'</ul>':'<p class="livre">Nada a fazer. Use o formulário acima para anotar.</p>';
  const nomes={};MATERIAS.forEach(m=>{nomes[m.toLowerCase()]=m;});state.items.forEach(i=>{if(!nomes[i.materia.toLowerCase()])nomes[i.materia.toLowerCase()]=i.materia;});
  state.materias.forEach(m=>{if(!nomes[m.nome.toLowerCase()])nomes[m.nome.toLowerCase()]=m.nome;});
  $('#lista-materias').innerHTML=Object.keys(nomes).map(k=>'<option value="'+esc(nomes[k])+'"></option>').join('');
  fillComp();
}
function renderFeitas(){
  const all=state.items.filter(i=>i.feita);
  const q=view.q.trim().toLowerCase();
  const items=all.filter(i=>!q||(i.titulo+' '+i.materia).toLowerCase().indexOf(q)>=0)
    .sort((a,b)=>(b.feitaEm||'').localeCompare(a.feitaEm||'')||a.titulo.localeCompare(b.titulo,'pt-BR'));
  $('#feitas-sum').textContent=all.length?plural(all.length,'atividade concluída','atividades concluídas')+(q?' · '+plural(items.length,'resultado','resultados'):''):'Quando você marcar uma atividade como feita, ela vem para cá.';
  if(!items.length){$('#feitas-lista').innerHTML='<div class="card"><p class="livre">'+(all.length?'Nenhuma atividade encontrada.':'Nenhuma atividade concluída ainda.')+'</p></div>';return;}
  let h='',cur='';
  items.forEach(i=>{
    const mk=(i.feitaEm||i.data).slice(0,7);
    if(mk!==cur){
      if(cur)h+='</ul></div>';
      cur=mk;const d=parse(mk+'-01');
      h+='<div class="card"><h3 class="grp">'+MESES[d.getMonth()]+' de '+d.getFullYear()+'</h3><ul class="itens">';
    }
    h+=itemHTML(i,{done:true,del:true});
  });
  h+='</ul></div>';
  $('#feitas-lista').innerHTML='<div class="stackc">'+h+'</div>';
}
function renderAll(){renderTop();renderResumo();renderAvisos();renderSemana();renderCal();renderRend();renderLista();renderFeitas();renderMaterias();fixWidths();}

/* ---------- Abas ---------- */
function showTab(name,focus){
  view.tab=name;
  document.querySelectorAll('[role="tab"]').forEach(b=>{const on=b.dataset.tab===name;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;if(on&&focus)b.focus();});
  document.querySelectorAll('.panel').forEach(p=>{p.hidden=p.id!=='p-'+name;});
  if(window.matchMedia&&window.matchMedia('(max-width:719px)').matches)window.scrollTo(0,0);
}
document.querySelector('.tabs').addEventListener('keydown',e=>{
  const tabs=Array.from(document.querySelectorAll('[role="tab"]')),i=tabs.indexOf(document.activeElement);
  if(i<0)return;let n=-1;
  if(e.key==='ArrowRight')n=(i+1)%tabs.length;else if(e.key==='ArrowLeft')n=(i-1+tabs.length)%tabs.length;
  if(n>=0){e.preventDefault();showTab(tabs[n].dataset.tab,true);}
});

/* ---------- Ações ---------- */
function toast(msg,undoId){
  const t=$('#toast'),u=$('#toast-undo');
  $('#toast-t').textContent=msg;u.hidden=!undoId;u.dataset.id=undoId||'';t.hidden=false;
  clearTimeout(toast.h);toast.h=setTimeout(()=>{t.hidden=true;},undoId?5000:2400);
}
document.addEventListener('click',e=>{
  const tb=e.target.closest('[data-tab]');
  if(tb){showTab(tb.dataset.tab);return;}
  const b=e.target.closest('[data-action]');
  if(!b)return;
  const a=b.dataset.action,id=b.dataset.id;
  if(a!=='del'&&a!=='del-dist'&&view.confirmDel){view.confirmDel=null;renderLista();renderFeitas();renderMaterias();}
  switch(a){
    case 'toggle':{
      const i=state.items.find(x=>x.id===id);if(!i)break;
      const done=!i.feita;
      change(()=>{i.feita=done;if(done)i.feitaEm=today();else delete i.feitaEm;});
      toast(done?'Movida para Feitas':'Voltou para pendentes',done?id:null);
      break;}
    case 'undo':
      change(()=>{const i=state.items.find(x=>x.id===id);if(i){i.feita=false;delete i.feitaEm;}});
      $('#toast').hidden=true;break;
    case 'ir-nova':showTab('nova');$('#f-titulo').focus();break;
    case 'wk-prev':view.weekStart=addDays(view.weekStart,-7);renderSemana();break;
    case 'wk-next':view.weekStart=addDays(view.weekStart,7);renderSemana();break;
    case 'wk-hoje':view.weekStart=addDays(new Date(),-new Date().getDay());renderSemana();break;
    case 'yr-prev':view.year--;view.sel=view.year+'-01-01';renderCal();break;
    case 'yr-next':view.year++;view.sel=view.year+'-01-01';renderCal();break;
    case 'yr-hoje':view.year=new Date().getFullYear();view.sel=today();renderCal();break;
    case 'cal-sel':view.sel=b.dataset.date;renderCal();break;
    case 'add-day':$('#f-data').value=b.dataset.date;showTab('nova');$('#f-titulo').focus();break;
    case 'rend-f':view.rf=b.dataset.v;renderRend();break;
    case 'edit-dist':{
      const g=matList().find(x=>x.key===b.dataset.key);if(!g)break;
      $('#fd-materia').value=g.nome;$('#f-dist').value=g.dist?distText(g.dist):'';$('#fd-erro').hidden=true;distPreview();
      showTab('nova');$('#form-dist').scrollIntoView();$('#f-dist').focus();
      break;}
    case 'del-dist':{
      const k='dist:'+b.dataset.key;
      if(view.confirmDel===k){
        view.confirmDel=null;
        const key=b.dataset.key;
        change(()=>{state.materias=state.materias.filter(m=>mkey(m.nome)!==key);state.items.forEach(i=>{if(mkey(i.materia)===key)delete i.comp;});});
        toast('Distribuição removida');
      }else{
        view.confirmDel=k;renderMaterias();clearTimeout(view.delT);view.delT=setTimeout(()=>{view.confirmDel=null;renderMaterias();},3500);
      }
      break;}
    case 'del':
      if(view.confirmDel===id){view.confirmDel=null;change(()=>{state.items=state.items.filter(x=>x.id!==id);});toast('Atividade apagada');}
      else{view.confirmDel=id;renderLista();renderFeitas();clearTimeout(view.delT);view.delT=setTimeout(()=>{view.confirmDel=null;renderLista();renderFeitas();},3500);}
      break;
  }
});
$('#f-busca').addEventListener('input',e=>{view.q=e.target.value;renderFeitas();});

/* ---------- Formulário ---------- */
function syncTipo(){const v=document.querySelector('input[name="tipo"]:checked').value;$('#f-data-l').textContent=TIPO_DIA[v]||'Dia da entrega';}
document.querySelectorAll('input[name="tipo"]').forEach(r=>r.addEventListener('change',syncTipo));
$('#f-data').value=today();
$('#form').addEventListener('submit',e=>{
  e.preventDefault();
  const titulo=$('#f-titulo').value.trim(),data=$('#f-data').value,err=$('#f-erro');
  if(!titulo){err.textContent='Escreva o que você precisa fazer.';err.hidden=false;$('#f-titulo').focus();return;}
  if(!ISO_RE.test(data)){err.textContent='Escolha o dia da entrega ou da prova.';err.hidden=false;$('#f-data').focus();return;}
  err.hidden=true;
  const item={id:'a'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),titulo,materia:$('#f-materia').value.trim()||'Geral',tipo:document.querySelector('input[name="tipo"]:checked').value,data,obs:$('#f-obs').value.trim(),feita:false};
  const cv=$('#f-comp').value;if(cv)item.comp=cv;
  change(()=>{state.items.push(item);});
  UP.afterSave(item.id);                 // envia os arquivos escolhidos (depois que a atividade estiver salva)
  $('#f-titulo').value='';$('#f-obs').value='';$('#f-comp').value='';$('#f-titulo').focus();
  const pd=parse(data);view.weekStart=addDays(pd,-pd.getDay());view.year=pd.getFullYear();view.sel=data;renderSemana();renderCal();
  toast('Anotada para '+fmtShort(data));
});

/* ---------- Matérias e distribuição da nota ---------- */
function mkey(s){return String(s||'').trim().toLowerCase();}
function fmtNum(n){return String(Math.round(n*100)/100).replace('.',',');}
function pontos(n){return fmtNum(n)+(Math.abs(n-1)<1e-9?' ponto':' pontos');}

/* Lê textos como "caderno 2, prova 4, trabalho 3" ou "caderno 2 pontos prova mult 4 trabalho 3" */
function parseDist(txt){
  const out=[];
  const clean=String(txt||'').replace(/(\d),(\d)/g,'$1.$2');
  const limpa=n=>n.replace(/^[\s:=\-–.]+|[\s:=\-–.]+$/g,'').replace(/^e\s+/i,'').trim();
  const add=(nome,num)=>{
    const max=parseFloat(num);
    if(!isFinite(max)||max<=0||max>100)return;
    nome=limpa(nome).slice(0,40);
    if(!nome)nome='Item '+(out.length+1);
    out.push({nome:nome.charAt(0).toUpperCase()+nome.slice(1),max:Math.round(max*100)/100});
  };
  clean.split(/[\n;,+]+/).forEach(raw=>{
    const seg=raw.trim();
    if(!seg)return;
    if(!/[:=\-–]/.test(seg)){
      const re=/([^\d]*?[a-zà-ÿ][^\d]*?)\s*(\d+(?:\.\d+)?)\s*(?:pontos?|pts?|pt)?(?![a-zà-ÿ])/gi;
      let mm,found=0;
      while((mm=re.exec(seg))){add(mm[1],mm[2]);found++;}
      if(found)return;
    }
    let m=seg.match(/^(.*?)[\s:=\-–]*(\d+(?:\.\d+)?)\s*(?:pontos?|pts?|pt)?\.?\s*$/i);
    if(m){add(m[1],m[2]);return;}
    m=seg.match(/^(\d+(?:\.\d+)?)\s*(?:pontos?|pts?|pt)?\s*(?:de|no|na|em|para)?\s*(.+)$/i);
    if(m)add(m[2],m[1]);
  });
  return out;
}
function distText(m){return m.comps.map(c=>(/\d/.test(c.nome)?c.nome+': ':c.nome+' ')+fmtNum(c.max)).join(', ');}
function getMat(key){return state.materias.find(m=>mkey(m.nome)===key)||null;}
function compNameOf(i){
  if(!i.comp)return '';
  const m=getMat(mkey(i.materia));if(!m)return '';
  const c=m.comps.find(x=>x.id===i.comp);
  return c?c.nome:'';
}
function matList(){
  const map={};
  state.materias.forEach(m=>{map[mkey(m.nome)]={key:mkey(m.nome),nome:m.nome,dist:m,items:[]};});
  state.items.forEach(i=>{
    const k=mkey(i.materia);
    if(!map[k])map[k]={key:k,nome:i.materia,dist:null,items:[]};
    map[k].items.push(i);
  });
  return Object.keys(map).map(k=>map[k]).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
}
function compMeta(c,items){
  const lk=items.filter(i=>i.comp===c.id),lf=lk.filter(i=>i.feita).length;
  let t='vale '+fmtNum(c.max);
  if(lk.length){t+=' · '+lf+' de '+lk.length+' feitas';if(lf===lk.length&&c.tirei==null)t+=' · aguardando nota';}
  return t;
}
function scoreOf(dist){
  let earned=0,max=0,aberto=0,n=0;
  dist.comps.forEach(c=>{max+=c.max;if(c.tirei!=null){earned+=c.tirei;n++;}else aberto+=c.max;});
  return {earned,max,aberto,n};
}
function hasDist(g){return !!(g.dist&&g.dist.comps.length);}
function ptsHTML(g){
  if(!hasDist(g))return '<small>sem distribuição</small>';
  const s=scoreOf(g.dist);
  if(!s.n)return '<small>sem notas ainda</small>';
  return fmtNum(s.earned)+'<small> / 10</small>';
}
function scoreHTML(g){
  const s=scoreOf(g.dist),pct=Math.max(0,Math.min(100,s.earned*10));
  let info;
  if(!s.n)info='Nenhuma nota lançada ainda. Preencha o campo "Tirei" em cada item.';
  else if(s.aberto>0)info=pontos(s.aberto)+' ainda em aberto. Máximo possível: '+fmtNum(s.earned+s.aberto)+'.';
  else info='Todos os itens já têm nota.';
  if(Math.abs(s.max-10)>0.001)info+=' A distribuição soma '+fmtNum(s.max)+', e não 10.';
  return '<span class="sc-big">'+fmtNum(s.earned)+'<small> de 10</small></span>'+
    '<div class="track" role="progressbar" aria-label="Pontos em '+esc(g.nome)+'" aria-valuemin="0" aria-valuemax="10" aria-valuenow="'+(Math.round(s.earned*100)/100)+'"><div class="fill" data-w="'+pct+'"></div></div>'+
    '<p class="sc-info">'+info+'</p>';
}
function matHTML(g){
  const done=g.items.filter(i=>i.feita).sort((a,b)=>(b.feitaEm||'').localeCompare(a.feitaEm||'')||a.titulo.localeCompare(b.titulo,'pt-BR'));
  const pen=g.items.filter(i=>!i.feita).sort((a,b)=>a.data.localeCompare(b.data)||cmp(a,b));
  const hd=hasDist(g);
  const k=esc(g.key);
  let h='<details class="mat" data-key="'+k+'"'+(view.open.has(g.key)?' open':'')+'><summary>'+
    '<div class="mat-n"><strong>'+esc(g.nome)+'</strong><span>'+plural(pen.length,'pendente','pendentes')+' · '+plural(done.length,'feita','feitas')+'</span></div>'+
    '<span class="mat-pts" data-pts="'+k+'">'+ptsHTML(g)+'</span><i class="mat-seta" aria-hidden="true"></i></summary><div class="mat-b">';
  if(hd){
    h+='<div class="sc" data-sc="'+k+'">'+scoreHTML(g)+'</div><ul class="comps">'+
      g.dist.comps.map(c=>{
        return '<li class="comp"><div class="comp-t"><span class="comp-n">'+esc(c.nome)+'</span><span class="comp-m">'+compMeta(c,g.items)+'</span></div>'+
          '<label class="nota">Tirei <input type="number" inputmode="decimal" min="0" max="'+c.max+'" step="0.1" placeholder="—" value="'+(c.tirei==null?'':c.tirei)+'" data-nota="'+esc(c.id)+'" data-mat="'+k+'" aria-label="Nota tirada em '+esc(c.nome)+', de '+fmtNum(c.max)+'"> de '+fmtNum(c.max)+'</label></li>';
      }).join('')+'</ul>';
  }else{
    h+='<p class="livre">Você ainda não anotou como o professor distribui a nota desta matéria.</p>';
  }
  const conf=view.confirmDel==='dist:'+g.key;
  h+='<div class="mat-act"><button type="button" class="ghost" data-action="edit-dist" data-key="'+k+'">'+(hd?'Editar distribuição':'Anotar distribuição')+'</button>'+
    (hd?'<button type="button" class="ghost'+(conf?' sure':'')+'" data-action="del-dist" data-key="'+k+'">'+(conf?'Remover mesmo?':'Remover distribuição')+'</button>':'')+UP.matChip(g.key,g.nome)+'</div>';
  h+='<div><h3 class="grp">Já fiz ('+done.length+')</h3>'+(done.length?'<ul class="itens">'+done.map(i=>itemHTML(i,{done:true})).join('')+'</ul>':'<p class="livre">Nada concluído nesta matéria ainda.</p>')+'</div>';
  h+='<div><h3 class="grp">A fazer ('+pen.length+')</h3>'+(pen.length?'<ul class="itens">'+pen.map(i=>itemHTML(i,{date:true,rel:true})).join('')+'</ul>':'<p class="livre">Nada pendente.</p>')+'</div>';
  return h+'</div></details>';
}
function renderMaterias(){
  const list=matList(),box=$('#mats');
  if(!list.length){
    box.innerHTML='<div class="card"><p class="livre">Nenhuma matéria ainda. Anote uma atividade ou a distribuição da nota de uma matéria.</p><button type="button" class="primary self-start" data-action="ir-nova">Anotar agora</button></div>';
    return;
  }
  box.innerHTML=list.map(matHTML).join('');
}
function updateScore(key){
  const g=matList().find(x=>x.key===key);if(!g)return;
  document.querySelectorAll('[data-sc]').forEach(el=>{if(el.dataset.sc===key)el.innerHTML=scoreHTML(g);});
  document.querySelectorAll('[data-pts]').forEach(el=>{if(el.dataset.pts===key)el.innerHTML=ptsHTML(g);});
  fixWidths();
}
function fillComp(){
  const m=getMat(mkey($('#f-materia').value)),w=$('#fc-wrap'),sel=$('#f-comp'),cur=sel.value;
  if(!m||!m.comps.length){w.hidden=true;sel.innerHTML='<option value="">Nenhum</option>';return;}
  sel.innerHTML='<option value="">Nenhum</option>'+m.comps.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.nome)+' (vale '+fmtNum(c.max)+')</option>').join('');
  if(m.comps.some(c=>c.id===cur))sel.value=cur;
  w.hidden=false;
}
function distPreview(){
  const comps=parseDist($('#f-dist').value),el=$('#dist-prev');
  if(!comps.length){el.innerHTML='';return;}
  const sum=comps.reduce((a,c)=>a+c.max,0);
  let msg,cls;
  if(Math.abs(sum-10)<0.001){msg='Soma 10 de 10.';cls='ok';}
  else if(sum<10){msg='Soma '+fmtNum(sum)+' de 10. Faltam '+pontos(10-sum)+'.';cls='warn';}
  else{msg='Soma '+fmtNum(sum)+', passa de 10 em '+pontos(sum-10)+'.';cls='warn';}
  el.innerHTML='<div class="dp">'+comps.map(c=>'<span class="c">'+esc(c.nome)+' <b>'+fmtNum(c.max)+'</b></span>').join('')+'</div><p class="dp-sum '+cls+'">'+msg+'</p>';
}
$('#f-dist').addEventListener('input',distPreview);
$('#f-materia').addEventListener('input',fillComp);
$('#form-dist').addEventListener('submit',e=>{
  e.preventDefault();
  const nome=$('#fd-materia').value.trim(),err=$('#fd-erro'),comps=parseDist($('#f-dist').value);
  if(!nome){err.textContent='Escolha ou escreva a matéria.';err.hidden=false;$('#fd-materia').focus();return;}
  if(!comps.length){err.textContent='Não consegui entender. Escreva cada item com o valor, por exemplo: caderno 2, prova 4, trabalho 3.';err.hidden=false;$('#f-dist').focus();return;}
  err.hidden=true;
  const key=mkey(nome);
  view.open.add(key);
  change(()=>{
    const m=getMat(key),old=m?m.comps:[];
    const novas=comps.map(c=>{
      const o=old.find(x=>x.nome.toLowerCase()===c.nome.toLowerCase());
      const t=(o&&o.tirei!=null)?Math.min(o.tirei,c.max):null;
      return {id:o?o.id:'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),nome:c.nome,max:c.max,tirei:t};
    });
    if(m){m.comps=novas;m.nome=nome;}
    else state.materias.push({id:'m'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),nome:nome,comps:novas});
    state.items.forEach(i=>{if(i.comp&&mkey(i.materia)===key&&!novas.some(c=>c.id===i.comp))delete i.comp;});
  });
  const comAnexos=UP.hasStaged('materia');
  if(comAnexos)UP.afterSaveMateria(nome);
  $('#f-dist').value='';$('#fd-materia').value='';distPreview();
  if(!comAnexos)showTab('mat');   // com anexos, fica no formulário para ver o envio
  toast('Distribuição de '+nome+' salva');
});
document.addEventListener('change',e=>{
  const inp=e.target;
  if(!inp||!inp.dataset||!inp.dataset.nota)return;
  const m=getMat(inp.dataset.mat);if(!m)return;
  const c=m.comps.find(x=>x.id===inp.dataset.nota);if(!c)return;
  const v=inp.value.trim().replace(',','.');
  if(v===''){c.tirei=null;}
  else{
    let n=parseFloat(v);if(!isFinite(n))n=0;
    n=Math.min(Math.max(n,0),c.max);
    c.tirei=Math.round(n*100)/100;
    inp.value=String(c.tirei);
  }
  persist();updateScore(inp.dataset.mat);
  const li=inp.closest('.comp'),mt=li&&li.querySelector('.comp-m');
  if(mt)mt.textContent=compMeta(c,state.items.filter(i=>mkey(i.materia)===inp.dataset.mat));
});
document.addEventListener('toggle',e=>{
  const d=e.target;
  if(d&&d.classList&&d.classList.contains('mat')){if(d.open)view.open.add(d.dataset.key);else view.open.delete(d.dataset.key);}
},true);

/* ---------- Virada de dia ---------- */
let lastDay=today();
function checkDay(){const t=today();if(t!==lastDay){lastDay=t;renderAll();if(me)ntState().then(st=>{if(st.mode==='local')localDigest(false);});}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){checkDay();refresh();}});
setInterval(checkDay,60000);


/* ---------- Resumo da semana (mesma lógica das notificações) ---------- */
function renderResumo(){
  const box=$('#resList');
  if(!state.items.length){box.innerHTML='<li class="av-vazio">Quando você anotar atividades, o resumo da semana aparece aqui.</li>';return;}
  const dg=buildDigest(state.items,today()),out=[];
  const row=(u,tag,main,sub)=>'<li class="av"><span class="pill '+u+'">'+esc(tag)+'</span><div class="av-txt"><strong>'+esc(main)+'</strong>'+(sub?'<span>'+esc(sub)+'</span>':'')+'</div></li>';
  const s=dg.semana;
  if(s.faltam>0)out.push(row('blue','Semana','Faltam '+plural(s.faltam,'atividade','atividades')+' para fechar a semana',s.feitas+' de '+s.total+' já feitas'));
  else out.push(row('ok','Semana','Semana em dia',s.total?'Tudo o que estava marcado até sábado já foi feito.':'Nada marcado até sábado.'));
  if(dg.atrasadas.length)out.push(row('red','Atrasadas',plural(dg.atrasadas.length,'atividade atrasada','atividades atrasadas'),dg.atrasadas.slice(0,3).map(x=>x.i.titulo+' ('+x.i.materia+')').join('; ')));
  dg.eventos.forEach(x=>{
    const tag=x.d===0?'Hoje':x.d===1?'Amanhã':'Em '+x.d+' dias';
    out.push(row(urg(x.d),tag,'Dia '+fmtDia(x.i.data)+' é '+NOME_FRASE[x.i.tipo]+' de '+x.i.materia,x.i.titulo));
  });
  if(!dg.eventos.length)out.push('<li class="av-vazio">Nenhuma prova, teste, apresentação ou seminário nos próximos 14 dias.</li>');
  box.innerHTML=out.join('');
}
function fixWidths(){$$('.fill[data-w]').forEach(el=>{el.style.width=el.dataset.w+'%';});}

/* ---------- Acesso: entrar, criar conta, recuperar ---------- */
const AUTH_PANELS={login:'af-login',reg:'af-reg',forgot:'af-forgot',mail:'af-mail',reset:'af-reset',codes:'af-codes'};
const AUTH_SUB={login:'Entre com seu e-mail e senha para ver suas atividades.',reg:'Crie sua conta para guardar suas atividades com segurança.',forgot:'Vamos ajudar você a voltar para a conta.',mail:'Vamos ajudar você a voltar para a conta.',reset:'Escolha uma senha nova.',codes:'Conta criada. Falta só um passo.'};
let resetToken=null, pendingCodes=null;
function setMsg(id,msg){const p=$('#'+id);if(!p)return;p.textContent=msg||'';p.hidden=!msg;}
const busy=(form,on)=>{form.querySelectorAll('button[type=submit]').forEach(b=>{b.disabled=on;});};
function showAuth(v,msg,focus){
  $('#boot').hidden=true;$('#app').hidden=true;$('#auth').hidden=false;
  Object.keys(AUTH_PANELS).forEach(k=>{$('#'+AUTH_PANELS[k]).hidden=k!==v;});
  $('#auth-tabs').hidden=!(v==='login'||v==='reg');
  [['login','#at-login'],['reg','#at-reg']].forEach(([k,sel])=>{const b=$(sel);b.setAttribute('aria-selected',String(v===k));b.tabIndex=v===k?0:-1;});
  $('#auth-sub').textContent=AUTH_SUB[v]||'';
  $('#f-mail-btn').hidden=!cfg.mailReset;
  $$('#auth .erro,#auth .ok-txt').forEach(p=>{p.hidden=true;p.textContent='';});
  if(msg)setMsg(msg.ok?'l-ok':'l-err',msg.text);
  if(focus&&v!=='codes'){const f=$('#'+AUTH_PANELS[v]+' input:not([type=checkbox])');if(f)f.focus();}
}
document.addEventListener('click',e=>{
  const a=e.target.closest('[data-auth]');
  if(a){showAuth(a.dataset.auth,null,true);return;}
  const s=e.target.closest('[data-show]');
  if(s){const inp=$('#'+s.dataset.show),on=inp.type==='password';inp.type=on?'text':'password';s.textContent=on?'Ocultar':'Mostrar';s.setAttribute('aria-pressed',String(on));}
});
$('#auth-tabs').addEventListener('keydown',e=>{
  if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;
  e.preventDefault();const to=document.activeElement&&document.activeElement.id==='at-login'?'reg':'login';
  showAuth(to,null,false);$(to==='login'?'#at-login':'#at-reg').focus();
});

/* Etapas da entrada: acompanham o que realmente acontece (conferir o formulário, o servidor verificar, a sessão abrir). */
const EMAIL_OK=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function mailMark(inp){const w=inp.closest('.field');if(w)w.classList.toggle('valid',EMAIL_OK.test(inp.value.trim()));}
$('#l-email').addEventListener('input',e=>mailMark(e.target));
$('#r-email').addEventListener('input',e=>mailMark(e.target));
const LOGIN_STEPS={
  set(n){ // n: 0 esconde; 1..3 marca as etapas anteriores como feitas e a atual como em andamento; 4 = tudo feito
    const ol=$('#l-steps');ol.hidden=n===0;
    ol.querySelectorAll('li').forEach(li=>{const k=+li.dataset.s;li.className=n>k||n===4?'done':n===k?'now':'';});
    $('#l-welcome').hidden=n!==4;
  }
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const calm=()=>window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

$('#af-login').addEventListener('submit',async e=>{
  e.preventDefault();
  const email=$('#l-email').value.trim(),password=$('#l-pw').value;
  setMsg('l-err','');setMsg('l-ok','');LOGIN_STEPS.set(0);
  if(!email||!password){setMsg('l-err','Preencha o e-mail e a senha.');return;}
  const body={email,password};
  if(!$('#l-code-w').hidden)body.code=$('#l-code').value.trim();
  busy(e.target,true);
  LOGIN_STEPS.set(2);                       // credenciais conferidas aqui; o servidor agora faz a verificação de segurança
  try{
    const r=await api('POST','/api/auth/login',body);
    LOGIN_STEPS.set(3);                     // sessão criada
    $('#l-pw').value='';$('#l-code').value='';$('#l-code-w').hidden=true;
    LOGIN_STEPS.set(4);
    if(!calm())await sleep(650);            // tempo curto para ver "Bem-vindo de volta!"
    await enterApp(r.user);
    LOGIN_STEPS.set(0);
  }catch(err){
    LOGIN_STEPS.set(0);
    if(err.code==='mfa_required'){$('#l-code-w').hidden=false;$('#l-code').focus();setMsg('l-err',MSG.mfa_required);}
    else setMsg('l-err',errMsg(err));
  }finally{busy(e.target,false);}
});

$('#af-reg').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('r-err','');
  const email=$('#r-email').value.trim(),password=$('#r-pw').value;
  if(!email||!password){setMsg('r-err','Preencha o e-mail e crie uma senha.');return;}
  if(!$('#r-terms').checked){setMsg('r-err',MSG.terms_required);return;}
  if(!$('#r-age').checked){setMsg('r-err',MSG.age_required);return;}
  busy(e.target,true);
  try{
    const r=await api('POST','/api/auth/register',{email,password,acceptTerms:true,confirmAge:true});
    $('#r-pw').value='';
    me=r.user;pendingCodes=r.recoveryCodes;
    $('#codes-list').innerHTML=pendingCodes.map(c=>'<li>'+esc(c)+'</li>').join('');
    $('#codes-ok').checked=false;$('#codes-go').disabled=true;
    showAuth('codes');
  }catch(err){setMsg('r-err',errMsg(err));}
  finally{busy(e.target,false);}
});
$('#codes-ok').addEventListener('change',e=>{$('#codes-go').disabled=!e.target.checked;});

$('#af-forgot').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('f-r-err','');setMsg('f-r-ok','');
  const email=$('#f-r-email').value.trim(),code=$('#f-r-code').value.trim(),pw=$('#f-r-pw').value;
  if(!email||!code||!pw){setMsg('f-r-err','Preencha o e-mail, o código e a nova senha.');return;}
  busy(e.target,true);
  try{
    const r=await api('POST','/api/auth/recover',{email,code,newPassword:pw,totp:$('#f-r-totp').value.trim()||undefined});
    ['f-r-code','f-r-pw','f-r-totp'].forEach(id=>{$('#'+id).value='';});
    $('#l-email').value=email;
    showAuth('login',{ok:true,text:'Senha trocada. Entre com a nova senha. Códigos de recuperação que ainda restam: '+r.codesLeft+'.'},true);
  }catch(err){setMsg('f-r-err',errMsg(err));}
  finally{busy(e.target,false);}
});

$('#af-mail').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('m-err','');setMsg('m-ok','');
  const email=$('#m-email').value.trim();
  if(!email){setMsg('m-err',MSG.invalid_email);return;}
  busy(e.target,true);
  try{await api('POST','/api/auth/forgot',{email});setMsg('m-ok','Se existir uma conta com esse e-mail, o link já foi enviado. Ele vale por 30 minutos.');}
  catch(err){setMsg('m-err',errMsg(err));}
  finally{busy(e.target,false);}
});

$('#af-reset').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('x-err','');
  const pw=$('#x-pw').value;
  if(!pw){setMsg('x-err','Digite a nova senha.');return;}
  busy(e.target,true);
  try{
    await api('POST','/api/auth/reset',{token:resetToken,newPassword:pw,totp:$('#x-totp').value.trim()||undefined});
    resetToken=null;$('#x-pw').value='';$('#x-totp').value='';
    showAuth('login',{ok:true,text:'Senha trocada. Entre com a nova senha.'},true);
  }catch(err){setMsg('x-err',errMsg(err));}
  finally{busy(e.target,false);}
});

function codesText(list){return 'Agenda Escolar - códigos de recuperação\nCada código funciona uma vez. Guarde em lugar seguro.\n\n'+list.join('\n')+'\n';}
function downloadBlob(name,text,type){
  const url=URL.createObjectURL(new Blob([text],{type:type||'text/plain;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}

/* ---------- Entrar e sair do app ---------- */
function resetView(){
  view.tab='semana';view.weekStart=addDays(new Date(),-new Date().getDay());view.year=new Date().getFullYear();view.sel=today();view.rf='tudo';view.q='';view.confirmDel=null;view.open=new Set();
  $('#f-busca').value='';$('#f-titulo').value='';$('#f-obs').value='';$('#f-materia').value='';$('#f-comp').value='';$('#f-dist').value='';$('#fd-materia').value='';
  $('#f-data').value=today();
}
function clearSession(msg){
  me=null;clearTimeout(saveTimer);clearTimeout(retryT);saveTimer=null;saving=false;
  state={v:1,items:[],materias:[]};base=snap(state);rev=0;UP.reset();
  const dlg=$('#conta');if(dlg.open)dlg.close();
  $$('input[type=password]').forEach(i=>{i.value='';});
  $$('#conta input[type=text],#af-login input[type=text]').forEach(i=>{i.value='';});
  resetView();renderAll();showTab('semana');
  $('#legacy-banner').hidden=true;$('#notif-banner').hidden=true;
  showAuth('login',msg?{ok:false,text:msg}:null,false);
}
function sessionExpired(){if(me)clearSession('Sua sessão expirou. Entre novamente.');}
async function enterApp(user){
  me=user;
  $('#boot').hidden=true;$('#auth').hidden=true;$('#app').hidden=false;
  state={v:1,items:[],materias:[]};base=snap(state);rev=0;resetView();renderAll();setStatus('wait');
  try{await loadState();}catch(e){if(me)setStatus('error');}
  UP.load();
  renderAll();showTab('semana');checkLegacy();initNotifications();
}
async function logout(){
  await disablePushQuietly();           // este aparelho não deve continuar recebendo avisos desta conta
  try{await api('POST','/api/auth/logout',{});}catch(e){}
  clearSession('');
}

/* ---------- Dados de antes das contas (localStorage) ---------- */
const SAFE_ID=/^[A-Za-z0-9_-]{1,40}$/;
const clean=(s,n)=>String(s==null?'':s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,' ').trim().slice(0,n);
const newId=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
function legacyData(){
  try{const s=localStorage.getItem(LS_KEY);if(!s)return null;const d=normalize(JSON.parse(s));return(d.items.length||d.materias.length)?d:null;}catch(e){return null;}
}
function checkLegacy(){
  const d=legacyData(),b=$('#legacy-banner');
  if(!d||ssGet('agenda-legacy-skip')){b.hidden=true;return;}
  $('#legacy-txt').textContent='Encontrei neste aparelho '+plural(d.items.length,'atividade','atividades')+' e '+plural(d.materias.length,'matéria','matérias')+' salvas antes das contas. Quer importar para a sua conta?';
  b.hidden=false;
}
async function importLegacy(){
  const d=legacyData();if(!d)return;
  const have=new Set(state.materias.map(m=>mkey(m.nome))),ids=new Set(state.items.map(i=>i.id)),mids=new Set(state.materias.map(m=>m.id));
  const keepComp=new Set();
  const mats=d.materias.filter(m=>!have.has(mkey(m.nome))).map(m=>({id:SAFE_ID.test(m.id)&&!mids.has(m.id)?m.id:newId('m'),nome:clean(m.nome,40)||'Matéria',comps:m.comps.slice(0,30).map(c=>({id:SAFE_ID.test(c.id)?c.id:newId('c'),nome:clean(c.nome,40)||'Item',max:c.max,tirei:c.tirei}))}));
  mats.forEach(m=>m.comps.forEach(c=>keepComp.add(c.id)));
  const items=d.items.map(i=>{
    const o={id:SAFE_ID.test(i.id)&&!ids.has(i.id)?i.id:newId('a'),titulo:clean(i.titulo,120)||'Atividade',materia:clean(i.materia,40)||'Geral',tipo:i.tipo,data:i.data,obs:clean(i.obs,300),feita:!!i.feita};
    if(o.feita)o.feitaEm=i.feitaEm||i.data;
    if(i.comp&&keepComp.has(i.comp))o.comp=i.comp;
    ids.add(o.id);return o;
  });
  const prog=$('#legacy-txt');prog.textContent='Importando…';
  change(()=>{state.items.push(...items);state.materias.push(...mats);});
  const ok=await flush();
  if(ok&&!pendingOps()){lsDel(LS_KEY);$('#legacy-banner').hidden=true;toast('Dados importados para a sua conta');}
  else{checkLegacy();toast('Não consegui importar agora. Seus dados continuam neste aparelho.');}
}

/* ---------- Avisos (notificações) ---------- */
const NT_OK=()=>('Notification' in window)&&('serviceWorker' in navigator);
const IS_IOS=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const IS_STANDALONE=()=>(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
const tzName=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'America/Sao_Paulo';}catch(e){return 'America/Sao_Paulo';}};
const b64uToU8=s=>{const p=s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4),b=atob(p),o=new Uint8Array(b.length);for(let i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o;};
async function swReg(){
  if(!('serviceWorker' in navigator))return null;
  try{return await Promise.race([navigator.serviceWorker.ready,new Promise(r=>setTimeout(()=>r(null),4000))]);}catch(e){return null;}
}
async function pushSub(){
  const reg=await swReg();
  if(!reg||!reg.pushManager)return null;
  try{return await reg.pushManager.getSubscription();}catch(e){return null;}
}
async function ntState(){
  if(!NT_OK())return {mode:'unsupported'};
  const perm=Notification.permission;
  if(perm==='denied')return {mode:'denied'};
  if(perm!=='granted')return {mode:'off'};
  const sub=await pushSub();
  if(sub&&me&&me.notif&&me.notif.enabled)return {mode:'push',sub};
  if(lsGet(K_LOCAL)==='1')return {mode:'local'};
  return {mode:'off'};
}
const horaTxt=h=>p2(h)+':00';
async function renderNotif(){
  const st=await ntState(),tg=$('#nt-toggle'),test=$('#nt-test'),sel=$('#nt-hora'),hint=$('#nt-hint'),txt=$('#nt-status');
  if(!sel.options.length){for(let h=0;h<24;h++){const o=document.createElement('option');o.value=String(h);o.textContent=horaTxt(h);sel.appendChild(o);}}
  sel.value=String((me&&me.notif&&Number.isInteger(me.notif.hour))?me.notif.hour:7);
  const iosHint=IS_IOS()&&!IS_STANDALONE()?'No iPhone e no iPad, os avisos só funcionam depois de adicionar o app à Tela de Início (Compartilhar > Adicionar à Tela de Início) e abri-lo por lá.':'';
  tg.hidden=false;test.hidden=true;sel.disabled=true;tg.textContent='Ativar avisos';hint.textContent=iosHint;
  if(st.mode==='unsupported'){txt.textContent='Este navegador não permite avisos.';tg.hidden=true;if(!iosHint)hint.textContent='';}
  else if(st.mode==='denied'){txt.textContent='Os avisos estão bloqueados neste navegador. Libere nas configurações do site para poder ativar.';tg.hidden=true;}
  else if(st.mode==='off'){txt.textContent='Os avisos estão desativados neste aparelho.';}
  else if(st.mode==='push'){txt.textContent='Avisos ativos. Você recebe o resumo todo dia às '+horaTxt(Number(sel.value))+', mesmo com o app fechado.';tg.textContent='Desativar avisos';test.hidden=false;sel.disabled=false;}
  else{
    txt.textContent='Avisos ativos enquanto o app estiver aberto: o resumo aparece quando você abre a agenda.';
    tg.textContent='Desativar avisos';test.hidden=false;
    hint.textContent=(cfg.vapidPublicKey?'Neste aparelho não consegui ativar os avisos com o app fechado.':'Os avisos com o app fechado ainda não foram configurados pelo responsável do site.')+(iosHint?' '+iosHint:'');
  }
}
async function showLocal(title,body){
  const reg=await swReg();
  const opts={body,tag:'agenda-resumo',icon:'icon-192.png',badge:'badge-72.png',lang:'pt-BR'};
  if(reg&&reg.showNotification)await reg.showNotification(title,opts);else new Notification(title,opts);
}
async function localDigest(force){
  if(!NT_OK()||Notification.permission!=='granted')return;
  const t=today();
  if(!force&&lsGet(K_LAST)===t)return;
  const msg=digestMessage(buildDigest(state.items,t));
  lsSet(K_LAST,t);
  if(!msg){if(force)toast('Nada para avisar agora: não há prazos perto.');return;}
  try{await showLocal(msg.title,msg.body);}catch(e){}
}
async function enableNotifications(){
  if(!NT_OK())return;
  let perm=Notification.permission;
  if(perm==='default'){try{perm=await Notification.requestPermission();}catch(e){perm='denied';}}
  if(perm!=='granted'){await renderNotif();return;}
  lsDel(K_DISMISS);
  let pushed=false;
  if(cfg.vapidPublicKey){
    try{
      const reg=await swReg();
      if(reg&&reg.pushManager){
        let sub=await reg.pushManager.getSubscription();
        if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64uToU8(cfg.vapidPublicKey)});
        const hour=Number($('#nt-hora').value);
        await api('POST','/api/push/subscribe',{subscription:sub.toJSON(),tz:tzName(),hour:Number.isInteger(hour)?hour:7});
        me.notif={enabled:true,hour:Number.isInteger(hour)?hour:7,tz:tzName()};
        pushed=true;
      }
    }catch(e){pushed=false;}
  }
  if(pushed)lsDel(K_LOCAL);else lsSet(K_LOCAL,'1');
  $('#notif-banner').hidden=true;
  await renderNotif();
  if(!pushed)localDigest(false);
}
async function disablePushQuietly(){
  try{
    const sub=await pushSub();
    if(sub){const ep=sub.endpoint;try{await api('POST','/api/push/unsubscribe',{endpoint:ep});}catch(e){}try{await sub.unsubscribe();}catch(e){}}
  }catch(e){}
  lsDel(K_LOCAL);
  if(me&&me.notif)me.notif.enabled=false;
}
async function disableNotifications(){await disablePushQuietly();await renderNotif();}
async function initNotifications(){
  const st=await ntState(),b=$('#notif-banner');
  b.hidden=!(NT_OK()&&Notification.permission==='default'&&lsGet(K_DISMISS)!=='1');
  if(st.mode==='local')localDigest(false);
}
$('#nt-hora').addEventListener('change',async()=>{
  const hour=Number($('#nt-hora').value);
  try{await api('PUT','/api/push/prefs',{hour,tz:tzName()});if(me&&me.notif)me.notif.hour=hour;await renderNotif();toast('Hora do aviso salva');}
  catch(e){toast(errMsg(e));}
});

/* ---------- Conta (janela) ---------- */
const fmtDT=ms=>{const d=new Date(ms);return p2(d.getDate())+'/'+p2(d.getMonth()+1)+' '+p2(d.getHours())+':'+p2(d.getMinutes());};
function syncTotpFields(){$$('#conta [data-totp]').forEach(el=>{el.hidden=!(me&&me.totp);});}
function renderTotp(){
  const on=!!(me&&me.totp);
  $('#tf-state').textContent=on?'Ativada: além da senha, o login pede um código do seu app autenticador.':'Desativada. Ativar deixa a conta mais difícil de invadir, mesmo que alguém descubra sua senha.';
  $('#f-tf-setup').hidden=on;$('#f-tf-disable').hidden=!on;$('#f-tf-enable').hidden=true;
  syncTotpFields();
}
async function loadSessions(){
  const ul=$('#sess-list');
  try{
    const r=await api('GET','/api/auth/sessions');
    ul.innerHTML=r.sessions.map(s=>'<li><span>'+(s.current?'<strong>Este aparelho</strong> · ':'')+esc(s.ua||'Navegador')+'</span><span class="muted">último uso '+esc(fmtDT(s.last_seen))+'</span></li>').join('')||'<li>Nenhum.</li>';
  }catch(e){ul.innerHTML='<li>Não foi possível carregar.</li>';}
}
async function openConta(){
  if(!me)return;
  $('#conta-email').textContent='Conta: '+me.email;
  ['pw-err','pw-ok','tf-err','tf-err2','tfd-err','rc-err','del-err','ex-err'].forEach(id=>setMsg(id,''));
  $('#rc-list').hidden=true;
  renderTotp();
  const d=$('#conta');if(!d.open)d.showModal();
  await renderNotif();
  if($('#sec-seg').open)loadSessions();
}
$('#sec-seg').addEventListener('toggle',()=>{if($('#sec-seg').open)loadSessions();});
$('#conta').addEventListener('click',e=>{if(e.target===$('#conta'))$('#conta').close();});

$('#f-pw').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('pw-err','');setMsg('pw-ok','');
  const cur=$('#pw-cur').value,nw=$('#pw-new').value;
  if(!cur||!nw){setMsg('pw-err','Preencha a senha atual e a nova senha.');return;}
  busy(e.target,true);
  try{
    await api('POST','/api/auth/change-password',{current:cur,next:nw,code:$('#pw-code').value.trim()||undefined});
    ['pw-cur','pw-new','pw-code'].forEach(id=>{$('#'+id).value='';});
    setMsg('pw-ok','Senha trocada. Os outros aparelhos saíram da conta.');loadSessions();
  }catch(err){setMsg('pw-err',errMsg(err));}
  finally{busy(e.target,false);}
});

$('#f-tf-setup').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('tf-err','');
  const pw=$('#tf-pw').value;if(!pw){setMsg('tf-err','Digite sua senha.');return;}
  busy(e.target,true);
  try{
    const r=await api('POST','/api/auth/totp/setup',{password:pw});
    $('#tf-pw').value='';$('#tf-secret').textContent=r.secret;
    const a=$('#tf-uri');a.setAttribute('href',/^otpauth:\/\//.test(r.uri)?r.uri:'#');
    $('#f-tf-setup').hidden=true;$('#f-tf-enable').hidden=false;$('#tf-code').focus();
  }catch(err){setMsg('tf-err',errMsg(err));}
  finally{busy(e.target,false);}
});
$('#f-tf-enable').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('tf-err2','');
  const code=$('#tf-code').value.trim();if(!code){setMsg('tf-err2','Digite o código de 6 dígitos.');return;}
  busy(e.target,true);
  try{
    await api('POST','/api/auth/totp/enable',{code});
    $('#tf-code').value='';$('#tf-secret').textContent='';me.totp=true;renderTotp();toast('Verificação em duas etapas ativada');loadSessions();
  }catch(err){setMsg('tf-err2',errMsg(err));}
  finally{busy(e.target,false);}
});
$('#f-tf-disable').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('tfd-err','');
  const pw=$('#tfd-pw').value,code=$('#tfd-code').value.trim();
  if(!pw||!code){setMsg('tfd-err','Digite a senha e o código do app autenticador.');return;}
  busy(e.target,true);
  try{
    await api('POST','/api/auth/totp/disable',{password:pw,code});
    ['tfd-pw','tfd-code'].forEach(id=>{$('#'+id).value='';});me.totp=false;renderTotp();toast('Verificação em duas etapas desativada');
  }catch(err){setMsg('tfd-err',errMsg(err));}
  finally{busy(e.target,false);}
});

$('#f-rc').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('rc-err','');
  const pw=$('#rc-pw').value;if(!pw){setMsg('rc-err','Digite sua senha.');return;}
  busy(e.target,true);
  try{
    const r=await api('POST','/api/auth/recovery-codes',{password:pw,code:$('#rc-code').value.trim()||undefined});
    $('#rc-pw').value='';$('#rc-code').value='';pendingCodes=r.recoveryCodes;
    const ol=$('#rc-list');ol.innerHTML=r.recoveryCodes.map(c=>'<li>'+esc(c)+'</li>').join('');ol.hidden=false;
    $('#rc-state').textContent='Códigos novos gerados. Os antigos não valem mais. Guarde estes agora, eles não aparecem de novo:';
  }catch(err){setMsg('rc-err',errMsg(err));}
  finally{busy(e.target,false);}
});

$('#f-del').addEventListener('submit',async e=>{
  e.preventDefault();setMsg('del-err','');
  const pw=$('#del-pw').value,conf=$('#del-confirm').value.trim();
  if(!pw){setMsg('del-err','Digite sua senha.');return;}
  if(conf!=='EXCLUIR'){setMsg('del-err',MSG.confirmation_required);return;}
  busy(e.target,true);
  try{
    await disablePushQuietly();
    await api('POST','/api/account/delete',{password:pw,confirm:'EXCLUIR',code:$('#del-code').value.trim()||undefined});
    lsDel(LS_KEY);
    clearSession('');setMsg('l-ok','Conta excluída. Seus dados foram apagados.');
  }catch(err){setMsg('del-err',errMsg(err));}
  finally{busy(e.target,false);}
});

/* ---------- Botões com data-do ---------- */
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-do]');if(!b)return;
  switch(b.dataset.do){
    case 'retry':location.reload();break;
    case 'conta-abrir':openConta();break;
    case 'conta-fechar':$('#conta').close();break;
    case 'logout':b.disabled=true;await logout();b.disabled=false;break;
    case 'codes-copy':
      try{await navigator.clipboard.writeText(codesText(pendingCodes||[]));toast('Códigos copiados');}
      catch(err){toast('Não deu para copiar. Selecione os códigos e copie à mão.');}
      break;
    case 'codes-download':downloadBlob('agenda-escolar-codigos-de-recuperacao.txt',codesText(pendingCodes||[]));break;
    case 'codes-go':pendingCodes=null;$('#codes-list').innerHTML='';await enterApp(me);break;
    case 'legacy-import':importLegacy();break;
    case 'legacy-skip':ssSet('agenda-legacy-skip','1');$('#legacy-banner').hidden=true;break;
    case 'legacy-drop':
      if(confirm('Apagar do aparelho as atividades antigas? Elas não foram importadas e não dá para recuperar.')){lsDel(LS_KEY);$('#legacy-banner').hidden=true;}
      break;
    case 'notif-on':case 'nt-toggle':
      if(b.dataset.do==='nt-toggle'){const st=await ntState();if(st.mode==='push'||st.mode==='local'){await disableNotifications();break;}}
      b.disabled=true;await enableNotifications();b.disabled=false;break;
    case 'notif-later':lsSet(K_DISMISS,'1');$('#notif-banner').hidden=true;break;
    case 'nt-test':{
      b.disabled=true;
      try{
        const st=await ntState();
        if(st.mode==='push'){const r=await api('POST','/api/push/test',{});toast(r.sent?'Aviso de teste enviado':'Não consegui enviar o teste agora');}
        else await localDigest(true);
      }catch(err){toast(errMsg(err));}
      b.disabled=false;break;}
    case 'sess-others':
      try{await api('POST','/api/auth/sessions/revoke-others',{});toast('Os outros aparelhos saíram da conta');loadSessions();}catch(err){toast(errMsg(err));}
      break;
    case 'export':
      setMsg('ex-err','');
      try{
        const res=await fetch('/api/account/export',{credentials:'same-origin',cache:'no-store'});
        if(!res.ok)throw new ApiError(res.status,'internal');
        downloadBlob('agenda-escolar-meus-dados.json',await res.text(),'application/json');
      }catch(err){setMsg('ex-err','Não foi possível baixar agora. Tente de novo.');}
      break;
  }
});

/* ---------- Início ---------- */
async function boot(){
  const m=/^#reset=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if(m){resetToken=m[1];history.replaceState(null,'',location.pathname+location.search);}   // o código sai da barra de endereço
  const msg=$('#boot-msg'),retry=$('#boot-retry');
  try{
    cfg=await api('GET','/api/config');
    const r=await api('GET','/api/auth/me');
    await enterApp(r.user);
  }catch(e){
    if(e.status===401){showAuth(resetToken?'reset':'login',null,false);return;}
    $('#boot').hidden=false;msg.textContent=errMsg(e);retry.hidden=false;
  }
}
if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').catch(()=>{});}
syncTipo();renderAll();setStatus('wait');
boot();
