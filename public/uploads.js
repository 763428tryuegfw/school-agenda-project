// Anexos da Agenda Escolar (cesta de basquete). Módulo independente: o app.js só o liga com `initUploads({...})`.
// Segurança: o servidor é quem decide o que é aceito (tipo pelo conteúdo, tamanho, cotas). Aqui só há conferência rápida
// para dar resposta imediata. Nomes de arquivo entram na tela sempre como TEXTO (textContent), nunca como HTML.

const EXT_OK = ['jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'm4v', 'mov', 'qt', '3gp', '3g2', 'webm',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv', 'md'];
const ACCEPT = 'image/*,video/*,.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.txt,.csv,.md';
const DEFAULT_LIMITS = { maxFileBytes: 20 * 1024 * 1024, accountBytes: 100 * 1024 * 1024, maxFiles: 100, maxItemFiles: 10 };
const SVG = 'http://www.w3.org/2000/svg';

const MSG = {
  file_too_large: 'Arquivo grande demais.',
  unsupported_file_type: 'Esse tipo de arquivo não é aceito (use foto, PDF, vídeo, documento ou texto).',
  quota_exceeded: 'Seu espaço de arquivos acabou. Apague algum anexo e tente de novo.',
  too_many_files: 'Você chegou ao limite de arquivos da conta.',
  too_many_item_files: 'Essa atividade já tem o máximo de anexos.',
  too_many_mat_files: 'Você já escolheu o máximo de arquivos de uma vez para esta matéria.',
  matter_unsaved: 'A matéria ainda não foi salva. Tente de novo.',
  item_not_found: 'A atividade ainda não foi salva. Tente de novo.',
  rate_limited: 'Muitos envios seguidos. Espere um pouco e tente de novo.',
  empty_file: 'O arquivo está vazio.',
  network: 'Sem conexão. Verifique a internet e tente de novo.',
  unauthenticated: 'Sua sessão expirou. Entre novamente.',
  sync_failed: 'A atividade não foi salva ainda; os arquivos não puderam ser enviados.',
};

export const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1).replace('.', ',') + ' MB' : n >= 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : n + ' B');
const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function svgEl(tag, attrs) { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

/** Cesta desenhada em SVG (decorativa). */
function hoop() {
  const s = svgEl('svg', { class: 'up-hoop', viewBox: '0 0 80 76', 'aria-hidden': 'true', focusable: 'false' });
  s.appendChild(svgEl('rect', { class: 'bb', x: '14', y: '2', width: '52', height: '30', rx: '3' }));
  s.appendChild(svgEl('rect', { class: 'bb2', x: '30', y: '12', width: '20', height: '14', rx: '2' }));
  const net = svgEl('g', { class: 'net' });
  net.appendChild(svgEl('path', { d: 'M20 38 L30 70 M30 38 L35 70 M40 38 L40 70 M50 38 L45 70 M60 38 L50 70 M22 48 H58 M26 59 H54' }));
  s.appendChild(net);
  s.appendChild(svgEl('ellipse', { class: 'rim', cx: '40', cy: '36', rx: '22', ry: '5' }));
  return s;
}

/**
 * @param {object} o
 * @param {() => Array} o.getItems       atividades atuais (para mostrar o título)
 * @param {() => void} o.onFilesChange   chamado quando a lista de arquivos do servidor muda (o app redesenha as listas)
 * @param {() => Promise<boolean>} o.flushSync  envia as atividades pendentes ao servidor (precisa existir antes do anexo)
 * @param {() => void} o.sessionExpired
 * @param {(msg: string) => void} o.toast
 */
export function initUploads(o) {
  const S = { files: [], limits: { ...DEFAULT_LIMITS }, usage: { count: 0, bytes: 0 }, loaded: false };
  const staged = [];                 // arquivos escolhidos, ainda sem atividade salva
  const jobs = [];                   // envios em andamento / concluídos / com erro
  const boxes = [];                  // caixas de upload montadas na página
  let seq = 0;

  // ------------------------------------------------------------ servidor
  async function jsonCall(method, path) {
    let res;
    try { res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store' }); } catch { throw { status: 0, code: 'network' }; }
    let d = null; try { d = await res.json(); } catch { /* sem corpo */ }
    if (!res.ok) { if (res.status === 401) o.sessionExpired(); throw { status: res.status, code: (d && d.error) || 'internal' }; }
    return d;
  }
  async function load() {
    try {
      const d = await jsonCall('GET', '/api/files');
      S.files = d.files || []; S.usage = d.usage || S.usage; S.limits = { ...DEFAULT_LIMITS, ...(d.limits || {}) }; S.loaded = true;
    } catch { /* continua com o que já tinha */ }
    renderAll(); o.onFilesChange();
  }
  function reset() { S.files = []; S.usage = { count: 0, bytes: 0 }; S.loaded = false; staged.length = 0; jobs.length = 0; renderAll(); }

  function sendFile(file, job, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/files');
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      if (job.scope === 'materia') { x.setRequestHeader('X-Scope', 'materia'); x.setRequestHeader('X-Materia', encodeURIComponent(job.materia)); }
      else { x.setRequestHeader('X-Scope', 'item'); x.setRequestHeader('X-Item-Id', job.itemId); }
      x.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let d = null; try { d = JSON.parse(x.responseText); } catch { /* sem corpo */ }
        if (x.status === 201 && d && d.file) resolve(d.file);
        else { if (x.status === 401) o.sessionExpired(); reject({ status: x.status, code: (d && d.error) || 'internal' }); }
      };
      x.onerror = () => reject({ status: 0, code: 'network' });
      x.ontimeout = () => reject({ status: 0, code: 'network' });
      x.timeout = 10 * 60 * 1000;
      x.send(file);
    });
  }

  // ------------------------------------------------------------ escolher arquivos
  function checkFile(f) {
    if (!EXT_OK.includes(extOf(f.name))) return MSG.unsupported_file_type;
    if (f.size === 0) return MSG.empty_file;
    if (f.size > S.limits.maxFileBytes) return 'Arquivo maior que ' + fmtSize(S.limits.maxFileBytes) + '.';
    return '';
  }
  const nArq = (n) => n + (n === 1 ? ' arquivo' : ' arquivos');
  function say(text, scope) { boxes.forEach((b) => { if (!scope || b.scope === scope) b.msg.textContent = text; }); }
  function addFiles(list, box) {
    const bad = [];
    let added = 0;
    for (const f of Array.from(list)) {
      const why = checkFile(f);
      if (why) { bad.push(f.name + ': ' + why); continue; }
      if (staged.filter((t) => t.scope === box.scope).length >= S.limits.maxItemFiles) { bad.push(f.name + ': ' + (box.scope === 'materia' ? MSG.too_many_mat_files : MSG.too_many_item_files)); continue; }
      staged.push({ key: ++seq, file: f, scope: box.scope }); added++;
    }
    say(bad.length ? bad.join(' ') : added ? nArq(added) + (added > 1 ? ' prontos' : ' pronto') + ' para anexar. Toque em "' + (box.scope === 'materia' ? 'Salvar distribuição' : 'Salvar atividade') + '".' : '', box.scope);
    renderAll();
    if (added && box) shoot(box, box.dropFrom || null, extOf(list[0] && list[0].name));
    if (box) box.dropFrom = null;
  }

  // ------------------------------------------------------------ enviar depois de salvar a atividade
  async function afterSave(itemId) { return commit('item', { itemId }); }
  /** Depois de salvar a distribuição da nota: envia os arquivos escolhidos para a matéria (não mexe em notas). */
  async function afterSaveMateria(nome) { return commit('materia', { materia: nome }); }
  async function commit(scope, target) {
    const take = staged.filter((t) => t.scope === scope);
    if (!take.length) return;
    take.forEach((t) => staged.splice(staged.indexOf(t), 1));
    const mine = take.map((t) => ({ key: t.key, file: t.file, scope, ...target, state: 'wait', pct: 0, error: '' }));
    jobs.push(...mine);
    renderAll();
    const ok = await o.flushSync();            // a atividade/matéria precisa estar no servidor antes de receber anexos
    if (!ok) { mine.forEach((j) => { j.state = 'error'; j.error = MSG.sync_failed; }); renderAll(); return; }
    for (const j of mine) await run(j);
    await afterRun(mine);
  }
  async function run(j) {
    j.state = 'sending'; j.pct = 0; j.error = ''; renderAll();
    try {
      await sendFile(j.file, j, (p) => { j.pct = p; paintJob(j); });
      j.state = 'done'; j.pct = 1;
    } catch (e) {
      j.state = 'error';
      j.error = e && e.code === 'file_too_large' ? 'Arquivo maior que ' + fmtSize(S.limits.maxFileBytes) + '.' : (MSG[e && e.code] || 'Não foi possível enviar. Tente de novo.');
    }
    renderAll();
  }
  async function afterRun(list) {
    const done = list.filter((j) => j.state === 'done').length, fail = list.filter((j) => j.state === 'error').length;
    if (done) { await load(); boxes.forEach((b) => swish(b)); }
    say(fail ? (done ? nArq(done) + (done > 1 ? ' enviados; ' : ' enviado; ') : '') + nArq(fail) + ' com erro. Veja abaixo e tente de novo.' : nArq(done) + (done > 1 ? ' enviados' : ' enviado') + ' com sucesso.', list[0] && list[0].scope);
    if (done) o.toast(nArq(done) + (done > 1 ? ' anexados' : ' anexado'));
    setTimeout(() => { for (const j of list) { if (j.state === 'done') { const i = jobs.indexOf(j); if (i >= 0) jobs.splice(i, 1); } } renderAll(); }, 6000);
  }
  async function retry(j) { await run(j); await afterRun([j]); }

  // ------------------------------------------------------------ animação
  const N_DOTS = 7;
  /** Ponto do arco (parábola) entre a mão e a cesta. */
  function arc(sx, sy, ex, ey, t, peak) { return { x: sx + (ex - sx) * t, y: sy + (ey - sy) * t - 4 * peak * t * (1 - t) }; }
  function rimPoint(box) {
    const d = box.drop.getBoundingClientRect(), h = box.hoopEl.getBoundingClientRect();
    return { x: h.left - d.left + h.width / 2, y: h.top - d.top + h.height * 0.42 };
  }
  const peakOf = (sx, sy, e) => Math.max(46, Math.hypot(e.x - sx, e.y - sy) * 0.4);
  function setHint(box, text) { if (box.hint) box.hint.textContent = text; }

  /** Enquanto o arquivo é arrastado: mostra o arquivo na ponta do ponteiro e a trilha de pontos até a cesta. */
  function aim(box, ev) {
    if (reduced()) return;
    const d = box.drop.getBoundingClientRect();
    const sx = Math.min(Math.max(ev.clientX - d.left, 12), d.width - 12), sy = Math.min(Math.max(ev.clientY - d.top, 12), d.height - 12);
    const e = rimPoint(box), peak = peakOf(sx, sy, e);
    box.hoopEl.classList.add('ready');
    box.aimEl.hidden = false;
    box.aimEl.style.transform = 'translate(' + (sx - 18) + 'px,' + (sy - 22) + 'px) rotate(-8deg)';
    box.dots.forEach((dot, i) => { const p = arc(sx, sy, e.x, e.y, (i + 1) / (N_DOTS + 1), peak); dot.style.left = p.x + 'px'; dot.style.top = p.y + 'px'; dot.hidden = false; });
    box.last = { x: sx, y: sy };
  }
  function unaim(box) {
    box.aimEl.hidden = true; box.dots.forEach((dot) => { dot.hidden = true; }); box.hoopEl.classList.remove('ready');
    setHint(box, 'ou solte aqui');
  }
  /** Arremesso: o arquivo sai de (sx,sy), faz um arco, entra na cesta e cai pela rede. */
  function shoot(box, from, label) {
    unaim(box);
    if (reduced() || !box.drop.animate) { swish(box); return; }
    const e = rimPoint(box);
    const d = box.drop.getBoundingClientRect();
    let sx, sy;
    if (from) { sx = from.x; sy = from.y; }
    else { const pb = box.pickBtn.getBoundingClientRect(); sx = pb.left - d.left + pb.width / 2; sy = pb.top - d.top + pb.height / 2; }
    const fly = el('span', 'up-fly'); fly.appendChild(el('span', 'up-ext', (label || 'arq').slice(0, 4))); box.drop.appendChild(fly);
    const peak = peakOf(sx, sy, e), frames = [], STEPS = 16;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS, p = arc(sx, sy, e.x, e.y, t, peak);
      frames.push({ transform: 'translate(' + (p.x - 18) + 'px,' + (p.y - 22) + 'px) rotate(' + (-8 + 380 * t) + 'deg) scale(' + (1 - 0.55 * t) + ')', opacity: 1, offset: t * 0.78 });
    }
    frames.push({ transform: 'translate(' + (e.x - 18) + 'px,' + (e.y + 14) + 'px) rotate(380deg) scale(.4)', opacity: 0.9, offset: 0.92 });
    frames.push({ transform: 'translate(' + (e.x - 18) + 'px,' + (e.y + 40) + 'px) rotate(380deg) scale(.3)', opacity: 0, offset: 1 });
    const a = fly.animate(frames, { duration: 900, easing: 'linear', fill: 'forwards' });
    setTimeout(() => swish(box), 700);                       // a bola/arquivo cruza o aro
    a.onfinish = () => { fly.remove(); bump(box); };
    setTimeout(() => fly.remove(), 1800);
  }
  function swish(box) { box.hoopEl.classList.remove('swish'); void box.hoopEl.getBoundingClientRect(); box.hoopEl.classList.add('swish'); }
  function bump(box) { box.count.classList.remove('bump'); void box.count.getBoundingClientRect(); box.count.classList.add('bump'); }

  // ------------------------------------------------------------ desenho
  const itemTitle = (id) => { const i = (o.getItems() || []).find((x) => x.id === id); return i ? i.titulo : ''; };
  const badge = (name) => el('span', 'up-ext', (extOf(name) || 'arq').slice(0, 4));

  function rowStaged(t) {
    const li = el('li', 'up-row');
    li.appendChild(badge(t.file.name));
    const mid = el('div', 'up-mid');
    mid.appendChild(el('span', 'up-name', t.file.name));
    mid.appendChild(el('span', 'up-meta', fmtSize(t.file.size) + ' · pronto para anexar'));
    li.appendChild(mid);
    const rm = el('button', 'ghost', 'Remover'); rm.type = 'button'; rm.dataset.up = 'rm-staged'; rm.dataset.key = String(t.key);
    rm.setAttribute('aria-label', 'Remover ' + t.file.name);
    li.appendChild(rm);
    return li;
  }
  function rowJob(j) {
    const li = el('li', 'up-row ' + j.state); li.dataset.job = String(j.key);
    li.appendChild(badge(j.file.name));
    const mid = el('div', 'up-mid');
    mid.appendChild(el('span', 'up-name', j.file.name));
    const label = j.state === 'done' ? 'Enviado com sucesso' : j.state === 'error' ? j.error : j.state === 'wait' ? 'Salvando a atividade…' : 'Enviando ' + Math.round(j.pct * 100) + '%';
    mid.appendChild(el('span', 'up-meta up-state', fmtSize(j.file.size) + ' · ' + label));
    const bar = el('div', 'up-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', 'Envio de ' + j.file.name);
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(Math.round(j.pct * 100)));
    const fill = el('div', 'up-fill'); fill.style.width = Math.round(j.pct * 100) + '%'; bar.appendChild(fill);
    mid.appendChild(bar);
    li.appendChild(mid);
    if (j.state === 'error') {
      const r = el('button', 'ghost', 'Tentar de novo'); r.type = 'button'; r.dataset.up = 'retry'; r.dataset.key = String(j.key);
      li.appendChild(r);
    }
    return li;
  }
  function paintJob(j) {
    boxes.forEach((b) => {
      const li = b.list.querySelector('[data-job="' + j.key + '"]'); if (!li) return;
      const pct = Math.round(j.pct * 100);
      li.querySelector('.up-fill').style.width = pct + '%';
      li.querySelector('.up-bar').setAttribute('aria-valuenow', String(pct));
      li.querySelector('.up-state').textContent = fmtSize(j.file.size) + ' · Enviando ' + pct + '%';
    });
  }
  function renderAll() {
    boxes.forEach((b) => {
      b.count.textContent = 'Enviados ' + (b.scope === 'materia' ? S.files.filter((f) => f.scope === 'materia').length : S.usage.count);
      b.list.textContent = '';
      staged.filter((t) => t.scope === b.scope).forEach((t) => b.list.appendChild(rowStaged(t)));
      jobs.filter((j) => j.scope === b.scope).forEach((j) => b.list.appendChild(rowJob(j)));
      b.list.hidden = !b.list.childElementCount;
    });
    if (dlg && dlg.open) renderDialog();
  }

  /** Monta a caixa de upload dentro do elemento `root`. */
  function mount(root, scope = 'item') {
    root.textContent = '';
    root.classList.add('up');
    const head = el('div', 'up-head');
    head.appendChild(el('strong', '', 'Anexar arquivos'));
    const count = el('span', 'pill ok', 'Enviados 0'); head.appendChild(count);
    root.appendChild(head);
    root.appendChild(el('p', 'up-sub', 'Arraste e solte ou escolha: foto, PDF, vídeo ou documento (Word, Excel, PowerPoint, texto). Até ' + fmtSize(S.limits.maxFileBytes) + ' cada.'));
    const drop = el('div', 'up-drop'); drop.setAttribute('role', 'group'); drop.setAttribute('aria-label', 'Área para soltar arquivos');
    const hoopEl = hoop(); drop.appendChild(hoopEl);
    const pick = el('button', 'primary up-pick', 'Escolher arquivos'); pick.type = 'button'; pick.dataset.up = 'pick';
    const input = el('input', 'up-input'); input.type = 'file'; input.multiple = true; input.accept = ACCEPT; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
    drop.appendChild(pick); drop.appendChild(input);
    const hint = el('span', 'up-hint', 'ou solte aqui'); hint.setAttribute('aria-hidden', 'true'); drop.appendChild(hint);
    const dots = []; for (let i = 0; i < N_DOTS; i++) { const dt = el('span', 'up-dot'); dt.hidden = true; dt.setAttribute('aria-hidden', 'true'); drop.appendChild(dt); dots.push(dt); }
    const aimEl = el('span', 'up-fly up-aim'); aimEl.hidden = true; aimEl.setAttribute('aria-hidden', 'true'); aimEl.appendChild(el('span', 'up-ext', 'arq')); drop.appendChild(aimEl);
    root.appendChild(drop);
    const list = el('ul', 'up-list'); list.setAttribute('aria-label', scope === 'materia' ? 'Arquivos desta matéria' : 'Arquivos desta atividade'); list.hidden = true; root.appendChild(list);
    const msg = el('p', 'up-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite'); root.appendChild(msg);
    const box = { root, scope, count, drop, hoopEl, list, msg, input, hint, dots, aimEl, pickBtn: pick, last: null, dropFrom: null };
    input.addEventListener('change', () => { addFiles(input.files, box); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('over'); setHint(box, 'Solte para arremessar!'); aim(box, e);
      const t = e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].type;   // mostra o tipo na mão (PDF, PNG...)
      const lab = t ? (t.split('/')[1] || '').replace('jpeg', 'jpg').slice(0, 4).toUpperCase() : '';
      if (lab && box.aimEl.firstChild) box.aimEl.firstChild.textContent = lab === 'PLAI' ? 'TXT' : lab;
    }));
    drop.addEventListener('dragleave', (e) => { e.preventDefault(); if (e.relatedTarget && drop.contains(e.relatedTarget)) return; drop.classList.remove('over'); unaim(box); });
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      box.dropFrom = box.last; unaim(box);
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files, box);
    });
    boxes.push(box);
    renderAll();
    return box;
  }

  // ------------------------------------------------------------ ver os anexos de uma atividade (janela)
  let dlg = null, dlgItem = null, dlgMat = null, dlgConfirm = null;
  const mk = (s) => String(s || '').trim().toLowerCase();
  const filesOf = (itemId) => S.files.filter((f) => f.itemId === itemId);
  const filesOfMat = (key) => S.files.filter((f) => f.scope === 'materia' && mk(f.materia) === key);
  const clipIcon = '<svg class="ic-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/></svg>';
  /** Botão "Anexos da matéria (N)" na aba Matérias (só aparece se houver arquivos). */
  function matChip(key, nome) {
    const n = filesOfMat(key).length;
    if (!n) return '';
    const k = String(key).replace(/[&<>"']/g, '');
    return '<button type="button" class="ghost arq-chip" data-up="mat-files" data-key="' + k + '" data-nome="' + String(nome || key).replace(/[&<>"']/g, '') + '" aria-label="Ver ' + n + (n === 1 ? ' arquivo anexado' : ' arquivos anexados') + ' a esta matéria">' + clipIcon + ' Anexos da matéria (' + n + ')</button>';
  }

  /** Botão "N anexos" que aparece em cada atividade que tem arquivos. */
  function chip(itemId) {
    const n = filesOf(itemId).length;
    if (!n) return '';
    const id = String(itemId).replace(/[^A-Za-z0-9_-]/g, '');
    return '<button type="button" class="arq-chip" data-up="item-files" data-id="' + id + '" aria-label="Ver ' + n + (n === 1 ? ' arquivo anexado' : ' arquivos anexados') + '">' +
      '<svg class="ic-sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/></svg>' + n + '</button>';
  }

  function renderDialog() {
    if (!dlg || (dlgItem === null && dlgMat === null)) return;
    const files = dlgMat !== null ? filesOfMat(dlgMat.key) : filesOf(dlgItem);
    dlg.querySelector('#arq-t').textContent = dlgMat !== null ? 'Arquivos da matéria: ' + dlgMat.nome : 'Arquivos de: ' + (itemTitle(dlgItem) || 'atividade');
    const ul = dlg.querySelector('#arq-list'); ul.textContent = '';
    if (!files.length) ul.appendChild(el('li', 'up-vazio', 'Nenhum arquivo anexado.'));
    files.forEach((f) => {
      const li = el('li', 'up-row'); li.appendChild(badge(f.name));
      const mid = el('div', 'up-mid'); mid.appendChild(el('span', 'up-name', f.name)); mid.appendChild(el('span', 'up-meta', fmtSize(f.size)));
      li.appendChild(mid);
      const acts = el('div', 'up-acts');
      if (f.inline && (f.kind === 'image' || f.kind === 'video')) { const b = el('button', 'ghost', 'Abrir'); b.type = 'button'; b.dataset.up = 'open'; b.dataset.id = f.id; b.setAttribute('aria-label', 'Abrir ' + f.name); acts.appendChild(b); }
      const a = el('a', 'ghost', 'Baixar'); a.href = '/api/files/' + encodeURIComponent(f.id) + '?download=1'; a.setAttribute('download', f.name); a.setAttribute('aria-label', 'Baixar ' + f.name); acts.appendChild(a);
      const del = el('button', 'ghost' + (dlgConfirm === f.id ? ' sure' : ''), dlgConfirm === f.id ? 'Apagar mesmo?' : 'Apagar'); del.type = 'button'; del.dataset.up = 'del'; del.dataset.id = f.id; del.setAttribute('aria-label', 'Apagar ' + f.name);
      acts.appendChild(del);
      li.appendChild(acts); ul.appendChild(li);
    });
  }
  function openItem(itemId) {
    dlg = dlg || document.getElementById('arq'); if (!dlg) return;
    dlgItem = itemId; dlgMat = null; dlgConfirm = null;
    dlg.querySelector('#arq-view').textContent = '';
    renderDialog();
    if (!dlg.open) dlg.showModal();
  }
  function openMateria(key, nome) {
    dlg = dlg || document.getElementById('arq'); if (!dlg) return;
    dlgMat = { key, nome: nome || key }; dlgItem = null; dlgConfirm = null;
    dlg.querySelector('#arq-view').textContent = '';
    renderDialog();
    if (!dlg.open) dlg.showModal();
  }
  function preview(id) {
    const f = S.files.find((x) => x.id === id); if (!f) return;
    const v = dlg.querySelector('#arq-view'); v.textContent = '';
    const url = '/api/files/' + encodeURIComponent(f.id);
    if (f.kind === 'image') { const im = el('img', 'arq-img'); im.src = url; im.alt = f.name; v.appendChild(im); }
    else if (f.kind === 'video') { const vd = el('video', 'arq-video'); vd.src = url; vd.controls = true; vd.playsInline = true; vd.preload = 'metadata'; v.appendChild(vd); }
  }
  async function removeFile(id) {
    if (dlgConfirm !== id) { dlgConfirm = id; renderDialog(); clearTimeout(removeFile.t); removeFile.t = setTimeout(() => { dlgConfirm = null; if (dlg && dlg.open) renderDialog(); }, 3500); return; }
    dlgConfirm = null;
    try {
      const res = await fetch('/api/files/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
      if (res.status === 401) o.sessionExpired();
      if (!res.ok && res.status !== 404) throw new Error('falhou');
      dlg.querySelector('#arq-view').textContent = '';
      await load(); o.toast('Arquivo apagado');
    } catch { o.toast('Não foi possível apagar. Tente de novo.'); renderDialog(); }
  }

  // ------------------------------------------------------------ eventos (delegados, sem manipuladores embutidos)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-up]'); if (!b) return;
    const a = b.dataset.up;
    if (a === 'pick') { const box = boxes.find((x) => x.root.contains(b)); if (box) box.input.click(); }
    else if (a === 'rm-staged') { const i = staged.findIndex((t) => String(t.key) === b.dataset.key); if (i >= 0) { const sc = staged[i].scope; staged.splice(i, 1); say('', sc); renderAll(); } }
    else if (a === 'retry') { const j = jobs.find((x) => String(x.key) === b.dataset.key); if (j) retry(j); }
    else if (a === 'item-files') openItem(b.dataset.id);
    else if (a === 'mat-files') openMateria(b.dataset.key, b.dataset.nome);
    else if (a === 'open') preview(b.dataset.id);
    else if (a === 'del') removeFile(b.dataset.id);
    else if (a === 'arq-fechar') { dlg.querySelector('#arq-view').textContent = ''; dlg.close(); }
  });
  document.addEventListener('close', (e) => { if (dlg && e.target === dlg) { dlgItem = null; dlgMat = null; } }, true);
  window.addEventListener('beforeunload', (e) => { if (jobs.some((j) => j.state === 'sending' || j.state === 'wait')) { e.preventDefault(); e.returnValue = ''; } });

  const hasStaged = (scope) => staged.some((t) => t.scope === scope);
  return { mount, hasStaged, load, reset, afterSave, afterSaveMateria, chip, matChip, openItem, openMateria, files: () => S.files };
}
