// Aviso de cookies da Agenda Escolar. Escolha guardada SÓ neste aparelho (localStorage), nunca enviada ao servidor.
// Hoje o app não usa nenhum cookie ou rastreador opcional: o único cookie (__Host-sid) é necessário para entrar e funciona
// mesmo com "Recusar opcionais". Qualquer recurso opcional que um dia exista deve chamar optionalAllowed() antes de ligar.
const KEY = 'agenda-cookies';
const VERSION = 1;                                  // sobe quando a lista de itens opcionais mudar (o aviso volta a perguntar)

function read() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d && d.v === VERSION && (d.choice === 'accepted' || d.choice === 'refused')) return d;
  } catch { /* sem armazenamento ou texto inválido: trata como "ainda não escolheu" */ }
  return null;
}
function write(choice) {
  let hist = [];
  try { const old = JSON.parse(localStorage.getItem(KEY) || 'null'); if (old && Array.isArray(old.hist)) hist = old.hist.slice(-9); if (old && old.choice) hist.push({ choice: old.choice, at: old.at }); } catch { /* ignora */ }
  const d = { v: VERSION, choice, at: new Date().toISOString(), hist };
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* sem armazenamento: a escolha vale só nesta visita */ }
  window.dispatchEvent(new CustomEvent('agenda:consent', { detail: { choice } }));
  return d;
}
/** true somente depois de um "Aceitar opcionais" explícito. */
export const optionalAllowed = () => { const d = read(); return !!d && d.choice === 'accepted'; };
window.agendaConsent = { optionalAllowed, get: read };

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
let bar = null;

function close() { if (bar) { bar.remove(); bar = null; } document.body.style.paddingBottom = ''; }
function choose(c) {
  write(c); close();
  const live = document.getElementById('consent-live');
  if (live) live.textContent = c === 'accepted' ? 'Opcionais aceitos. Hoje não há nenhum em uso.' : 'Opcionais recusados. O app continua funcionando normalmente.';
}
function show() {
  if (bar) return;
  const cur = read();
  bar = el('section', 'consent'); bar.id = 'consent'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-labelledby', 'consent-t');
  const txt = el('div', 'consent-txt');
  txt.appendChild(el('strong', '', 'Cookies')).id = 'consent-t';
  txt.appendChild(el('p', '', 'A Agenda Escolar usa só um cookie necessário, que mantém você conectado e funciona mesmo se você recusar. Hoje não há cookies opcionais (estatística ou publicidade) em uso. Se um dia houver, só serão ligados depois do seu "Aceitar".'));
  const a = el('a', '', 'Ler a política de cookies'); a.href = 'cookies.html'; a.target = '_blank'; a.rel = 'noopener'; txt.appendChild(a);
  if (cur) txt.appendChild(el('p', 'consent-now', 'Sua escolha atual: ' + (cur.choice === 'accepted' ? 'aceitar opcionais' : 'recusar opcionais') + '.'));
  const row = el('div', 'consent-btns');
  const no = el('button', 'consent-btn', 'Recusar opcionais'); no.type = 'button'; no.dataset.consent = 'refused';
  const yes = el('button', 'consent-btn', 'Aceitar opcionais'); yes.type = 'button'; yes.dataset.consent = 'accepted';
  row.appendChild(no); row.appendChild(yes);                 // mesmo tamanho, mesma cor, mesmo destaque
  bar.appendChild(txt); bar.appendChild(row);
  document.body.appendChild(bar);
  document.body.style.paddingBottom = (bar.offsetHeight + 16) + 'px';
}
function boot() {
  if (!document.getElementById('consent-live')) { const l = el('p', 'consent-live'); l.id = 'consent-live'; l.setAttribute('role', 'status'); l.setAttribute('aria-live', 'polite'); document.body.appendChild(l); }
  if (!read()) show();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-consent]'); if (!b) return;
  const v = b.dataset.consent;
  if (v === 'open') { const dg = b.closest('dialog'); if (dg && dg.open) dg.close(); close(); show(); const f = document.querySelector('#consent .consent-btn'); if (f) f.focus(); }
  else if (v === 'accepted' || v === 'refused') choose(v);
});
window.addEventListener('resize', () => { if (bar) document.body.style.paddingBottom = (bar.offsetHeight + 16) + 'px'; });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
