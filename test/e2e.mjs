// Teste ponta a ponta no navegador (Chromium) contra o servidor local. Não faz parte do `npm test` porque precisa do Playwright.
// Rode:  PLAYWRIGHT_DIR=/caminho/node_modules node test/e2e.mjs      (screenshots em test/shots/)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire((process.env.PLAYWRIGHT_DIR || '/opt/npm-tools/node_modules') + '/');
const { chromium } = req('playwright');
const SHOTS = join(ROOT, 'test', 'shots'); mkdirSync(SHOTS, { recursive: true });
const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts/dev-server.mjs'), String(PORT)], { stdio: 'pipe' });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('em http')) res(); }));

const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); console.log('ok   ', name); } catch (e) { results.push(['FALHA', name, e.message]); console.log('FALHA', name, '\n     ', e.message.split('\n')[0]); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', permissions: ['notifications'] });
const page = await ctx.newPage();
const problems = [];
await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
page.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401)|net::ERR_FAILED/.test(m.text())) problems.push('console: ' + m.text()); });   // 401/400 esperados: /me sem sessão, senha errada, código errado
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const EMAIL = `aluno${Date.now()}@example.com`, PW = 'Uma-Frase-Longa-Para-Senha-42';

async function addActivity({ titulo, materia, tipoLabel, data }) {
  await page.click('#t-nova');
  await page.fill('#f-titulo', titulo);
  await page.fill('#f-materia', materia);
  await page.fill('#f-data', data);
  await page.click(`label:has-text("${tipoLabel}") >> nth=0`);
  await page.click('#form button[type=submit]');
}

await step('abre na tela de entrada, sem dados do app visíveis', async () => {
  await page.goto(BASE + '/');
  await page.waitForSelector('#auth:not([hidden])');
  assert.equal(await page.isHidden('#app'), true);
  await page.screenshot({ path: join(SHOTS, '01-entrar.png') });
});
await step('aviso de cookies: aparece antes de tudo, botões iguais, nada opcional antes do aceite, recusar não quebra nada', async () => {
  await page.waitForSelector('#consent');
  assert.equal(await page.evaluate(() => localStorage.getItem('agenda-cookies')), null, 'nada guardado antes da escolha');
  assert.deepEqual(await ctx.cookies(), [], 'nenhum cookie antes de entrar');
  const yes = page.locator('#consent [data-consent=accepted]'), no = page.locator('#consent [data-consent=refused]');
  const [by, bn] = [await yes.boundingBox(), await no.boundingBox()];
  assert.ok(Math.abs(by.width - bn.width) < 2 && Math.abs(by.height - bn.height) < 2, 'os dois botões têm o mesmo tamanho');
  const st = (l) => l.evaluate((e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, c.fontWeight, c.fontSize, c.borderTopWidth].join('|'); });
  assert.equal(await st(yes), await st(no), 'mesmo estilo');
  assert.equal(await yes.textContent(), 'Aceitar opcionais'); assert.equal(await no.textContent(), 'Recusar opcionais');
  assert.equal(await page.evaluate(() => window.agendaConsent.optionalAllowed()), false);
  await page.screenshot({ path: join(SHOTS, '01b-cookies.png') });
  await no.click();
  await page.waitForSelector('#consent', { state: 'detached' });
  const d = JSON.parse(await page.evaluate(() => localStorage.getItem('agenda-cookies')));
  assert.equal(d.choice, 'refused'); assert.equal(await page.evaluate(() => window.agendaConsent.optionalAllowed()), false);
  await page.reload(); await page.waitForSelector('#auth:not([hidden])');
  assert.equal(await page.locator('#consent').count(), 0, 'depois de escolher, o aviso não volta sozinho');
});
await step('mudar a escolha depois: "Preferências de cookies" reabre o aviso; aceitar libera, guardando o histórico', async () => {
  await page.click('#auth [data-consent=open]');
  await page.waitForSelector('#consent');
  assert.match(await page.textContent('#consent .consent-now'), /recusar opcionais/);
  await page.click('#consent [data-consent=accepted]');
  assert.equal(await page.evaluate(() => window.agendaConsent.optionalAllowed()), true);
  const d = JSON.parse(await page.evaluate(() => localStorage.getItem('agenda-cookies')));
  assert.equal(d.choice, 'accepted'); assert.equal(d.hist[d.hist.length - 1].choice, 'refused');
  await page.click('#auth [data-consent=open]'); await page.click('#consent [data-consent=refused]');
  assert.equal(await page.evaluate(() => window.agendaConsent.optionalAllowed()), false);
});
await step('páginas legais: anexos, exportação sem o conteúdo, passo a passo e botão de preferências', async () => {
  await page.goto(BASE + '/privacidade.html');
  const t = await page.textContent('main.legal');
  for (const re of [/Arquivos anexados/, /nome do arquivo/, /conteúdo dos anexos não vai dentro do JSON/, /Apagar uma atividade não apaga/, /Excluir minha conta/, /Pedir ajuda ao responsável/, /Nunca envie a sua senha/]) assert.match(t, re);
  assert.equal(await page.locator('#consent').count(), 0, 'já escolhi: sem aviso');
  assert.equal(await page.locator('[data-consent=open]').count(), 1);
  await page.goto(BASE + '/cookies.html'); assert.match(await page.textContent('main.legal'), /Hoje não usamos nenhum cookie ou rastreador opcional/);
  await page.goto(BASE + '/'); await page.waitForSelector('#auth:not([hidden])');
});
await step('criar conta exige os dois aceites e mostra os códigos de recuperação', async () => {
  await page.click('#at-reg');
  await page.fill('#r-email', EMAIL); await page.fill('#r-pw', PW);
  await page.click('#af-reg button[type=submit]');
  assert.match(await page.textContent('#r-err'), /Termos/);
  await page.check('#r-terms'); await page.click('#af-reg button[type=submit]');
  assert.match(await page.textContent('#r-err'), /idade/);
  await page.check('#r-age'); await page.click('#af-reg button[type=submit]');
  await page.waitForSelector('#af-codes:not([hidden])');
  assert.equal(await page.locator('#codes-list li').count(), 8);
  assert.equal(await page.isDisabled('#codes-go'), true);
  await page.screenshot({ path: join(SHOTS, '02-codigos.png') });
  await page.check('#codes-ok'); await page.click('#codes-go');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForFunction(() => /Salvo/.test(document.querySelector('#status').textContent));
});
await step('cria atividades de todos os tipos e o resumo mostra "dia X é prova/teste/apresentação/seminário"', async () => {
  await addActivity({ titulo: 'Prova do bimestre', materia: 'Matemática', tipoLabel: 'Prova', data: inDays(2) });
  await addActivity({ titulo: 'Teste de verbos', materia: 'Inglês', tipoLabel: 'Teste', data: inDays(3) });
  await addActivity({ titulo: 'Apresentar o grupo 3', materia: 'História', tipoLabel: 'Apresentação', data: inDays(5) });
  await addActivity({ titulo: 'Seminário de clima', materia: 'Geografia', tipoLabel: 'Seminário', data: inDays(8) });
  await addActivity({ titulo: 'Lista 4', materia: 'Física', tipoLabel: 'Tarefa', data: inDays(1) });
  await addActivity({ titulo: 'Relatório de lab', materia: 'Química', tipoLabel: 'Entrega de trabalho', data: inDays(-1) });
  await page.click('#t-semana');
  const txt = await page.textContent('#resList');
  for (const re of [/é prova de Matemática/, /é teste de Inglês/, /é apresentação de História/, /é seminário de Geografia/, /atrasada/, /Faltam|Semana em dia/]) assert.match(txt, re);
  await page.screenshot({ path: join(SHOTS, '03-semana-celular.png'), fullPage: true });
});
await step('os dados ficam no servidor: recarregar mantém a sessão e as atividades', async () => {
  await page.waitForFunction(() => /Salvo/.test(document.querySelector('#status').textContent));
  await page.reload(); await page.waitForSelector('#app:not([hidden])');
  await page.click('#t-nova');
  assert.match(await page.textContent('#lista'), /Prova do bimestre/);
  assert.match(await page.textContent('#lista'), /Seminário de clima/);
});
await step('texto malicioso vira texto (sem XSS)', async () => {
  await addActivity({ titulo: '<img src=x onerror="window.__xss=1">', materia: '<b>x</b>', tipoLabel: 'Tarefa', data: inDays(4) });
  await addActivity({ titulo: '<svg onload="window.__xss=2">', materia: '<i id="pwn">M</i>', tipoLabel: 'Prova', data: inDays(2) });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await page.textContent('#lista'), /<img src=x/);
  await page.click('#t-semana');
  assert.equal(await page.locator('#pwn').count(), 0, 'HTML da matéria virou elemento no resumo');
  assert.match(await page.textContent('#resList'), /<i id="pwn">M<\/i>/);
  await page.click('#t-nova');
  // o mesmo texto numa prova aparece no resumo da semana ("dia X é prova de ...") e nos avisos: também sem executar
  await page.click('#t-nova');
  await page.fill('#f-titulo', '<svg onload="window.__xss=3">'); await page.fill('#f-materia', '<img src=x onerror="window.__xss=2">');
  await page.fill('#f-data', inDays(2)); await page.fill('#f-obs', '</span><img src=x onerror="window.__xss=4">');
  await page.click('label:has-text("Prova") >> nth=0'); await page.click('#form button[type=submit]');
  await page.click('#t-semana'); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await page.textContent('#resList'), /é prova de <img src=x/);
  assert.equal(await page.locator('#resList img, #avList img, #semana-grid img, #lista img, svg[onload]').count(), 0, 'nenhum elemento injetado');
});
await step('cookie de sessão: HttpOnly, Secure, SameSite; invisível ao JavaScript', async () => {
  const c = (await ctx.cookies()).find((x) => x.name === '__Host-sid');
  assert.ok(c, 'cookie ausente'); assert.equal(c.httpOnly, true); assert.equal(c.secure, true); assert.equal(c.sameSite, 'Lax');
  assert.ok(!(await page.evaluate(() => document.cookie)).includes('sid'));
  const ls = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)));
  assert.ok(!/sid|token|senha|password/i.test(ls), 'algo suspeito no armazenamento local: ' + ls);
});
await step('sair, entrar com senha errada e depois com a certa', async () => {
  await page.click('#btn-conta'); await page.click('[data-do=logout]');
  await page.waitForSelector('#auth:not([hidden])');
  assert.equal(await page.isHidden('#app'), true);
  assert.equal(await page.textContent('#lista'), 'Nada a fazer. Use o formulário acima para anotar.');
  await page.fill('#l-email', EMAIL); await page.fill('#l-pw', 'Senha-Errada-1234'); await page.click('#af-login button[type=submit]');
  await page.waitForSelector('#l-err:not([hidden])');
  assert.match(await page.textContent('#l-err'), /incorretos/);
  assert.equal(await page.isHidden('#l-steps'), true, 'erro: as etapas somem e a mensagem aparece');
  assert.equal(await page.locator('#l-email').evaluate((e) => e.closest('.field').classList.contains('valid')), true, 'e-mail válido mostra a marca');
  await page.fill('#l-email', 'isso-nao-e-email'); assert.equal(await page.locator('#l-email').evaluate((e) => e.closest('.field').classList.contains('valid')), false);
  await page.fill('#l-email', EMAIL);
  await page.fill('#l-pw', PW); await page.click('#af-login button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#l-welcome').hidden);
  assert.equal(await page.locator('#l-steps li.done').count(), 3, 'as 3 etapas aparecem concluídas');
  assert.match(await page.textContent('#l-welcome'), /Bem-vindo de volta!/);
  await page.screenshot({ path: join(SHOTS, '02b-entrando.png') });
  await page.waitForSelector('#app:not([hidden])');
  await page.click('#t-nova'); assert.match(await page.textContent('#lista'), /Lista 4/);
});
await step('importa os dados antigos do aparelho (antes das contas) e limpa o armazenamento local', async () => {
  await page.evaluate((d) => localStorage.setItem('agenda-escolar-v1', JSON.stringify({ v: 1, items: [{ id: 'aold1', titulo: 'Trabalho antigo', materia: 'Artes', tipo: 'entrega', data: d, obs: '', feita: false }], materias: [] })), inDays(6));
  await page.reload(); await page.waitForSelector('#legacy-banner:not([hidden])');
  await page.click('[data-do=legacy-import]');
  await page.waitForSelector('#legacy-banner', { state: 'hidden' });
  assert.equal(await page.evaluate(() => localStorage.getItem('agenda-escolar-v1')), null);
  await page.click('#t-nova'); assert.match(await page.textContent('#lista'), /Trabalho antigo/);
});
await step('avisos: ativar neste aparelho e enviar aviso de teste', async () => {
  await page.click('#btn-conta'); await page.waitForSelector('#conta[open]');
  await page.screenshot({ path: join(SHOTS, '04-conta.png') });
  await page.click('#nt-toggle'); await page.waitForTimeout(400);
  assert.match(await page.textContent('#nt-status'), /ativos/);
  await page.click('#nt-test'); await page.waitForTimeout(300);
  await page.click('[data-do=conta-fechar]');
});
await step('verificação em duas etapas: começar, ver a chave e recusar código errado', async () => {
  await page.click('#btn-conta'); await page.click('#sec-seg summary');
  await page.fill('#tf-pw', PW); await page.click('#f-tf-setup button[type=submit]');
  await page.waitForSelector('#f-tf-enable:not([hidden])');
  assert.match(await page.textContent('#tf-secret'), /^[A-Z2-7]{32}$/);
  await page.fill('#tf-code', '000000'); await page.click('#f-tf-enable button[type=submit]');
  await page.waitForSelector('#tf-err2:not([hidden])');
  assert.match(await page.textContent('#tf-err2'), /incorreto/);
  await page.screenshot({ path: join(SHOTS, '05-duas-etapas.png') });
  await page.click('[data-do=conta-fechar]');
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let fileUrl = '';
await step('anexos em "Anotar atividade": prévia com nome e tamanho, recusa de arquivo ruim, remover antes de salvar', async () => {
  await page.click('#t-nova');
  await page.setInputFiles('#up-nova .up-input', [
    { name: 'foto.png', mimeType: 'image/png', buffer: PNG },
    { name: 'resumo.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'programa.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ-programa') },
  ]);
  assert.equal(await page.locator('#up-nova .up-row').count(), 2);
  const txt = await page.textContent('#up-nova .up-list');
  assert.match(txt, /foto\.png/); assert.match(txt, /resumo\.pdf/); assert.match(txt, /\d+ B|KB/);
  assert.match(await page.textContent('#up-nova .up-msg'), /programa\.exe.*não é aceito/);
  await page.click('[aria-label="Remover resumo.pdf"]');
  assert.equal(await page.locator('#up-nova .up-row').count(), 1);
  await page.screenshot({ path: join(SHOTS, '07-anexo-previa.png'), fullPage: true });
});
await step('salvar a atividade envia o arquivo com barra de progresso e mostra "enviado com sucesso"', async () => {
  await page.fill('#f-titulo', 'Trabalho com anexo'); await page.fill('#f-materia', 'Artes'); await page.fill('#f-data', inDays(5));
  await page.click('label:has-text("Entrega de trabalho") >> nth=0');
  await page.click('#form button[type=submit]');
  await page.waitForSelector('#up-nova .up-row.done');
  assert.match(await page.textContent('#up-nova .up-state'), /Enviado com sucesso/);
  assert.equal(await page.getAttribute('#up-nova .up-bar', 'aria-valuenow'), '100');
  await page.waitForFunction(() => /Enviados 1/.test(document.querySelector('#up-nova .pill').textContent));
  await page.screenshot({ path: join(SHOTS, '08-anexo-enviado.png'), fullPage: true });
});
await step('persistência: depois de recarregar, a atividade mostra o anexo; abrir, baixar e conferir os bytes', async () => {
  await page.waitForFunction(() => /Salvo/.test(document.querySelector('#status').textContent));
  await page.reload(); await page.waitForSelector('#app:not([hidden])');
  await page.click('#t-nova');
  const chip = page.locator('#lista .arq-chip');
  assert.equal(await chip.count(), 1);
  assert.match(await chip.first().getAttribute('aria-label'), /1 arquivo anexado/);
  await chip.first().click();
  await page.waitForSelector('#arq[open]');
  assert.match(await page.textContent('#arq-list'), /foto\.png/);
  await page.click('#arq [data-up=open]');
  await page.waitForFunction(() => { const i = document.querySelector('#arq-view img'); return i && i.complete && i.naturalWidth === 1; });
  fileUrl = await page.getAttribute('#arq-list a[download]', 'href');
  const same = await page.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return { cd: r.headers.get('content-disposition'), len: b.length, head: Array.from(b.slice(0, 4)) }; }, fileUrl);
  assert.match(same.cd, /^attachment/); assert.equal(same.len, PNG.length); assert.deepEqual(same.head, [0x89, 0x50, 0x4E, 0x47]);
  await page.screenshot({ path: join(SHOTS, '09-anexo-janela.png') });
});
await step('permissão: sem a sessão o arquivo não abre (401) e outra conta recebe 404', async () => {
  const anon = await browser.newContext(); const r = await anon.request.get(BASE + fileUrl.split('?')[0]); assert.equal(r.status(), 401);
  const other = await browser.newContext({ locale: 'pt-BR' }); await other.addInitScript(() => { try { localStorage.setItem('agenda-cookies', JSON.stringify({ v: 1, choice: 'refused', at: new Date().toISOString(), hist: [] })); } catch {} }); const op = await other.newPage();
  await op.goto(BASE + '/'); await op.waitForSelector('#auth:not([hidden])');
  await op.click('#at-reg'); await op.fill('#r-email', 'outra' + Date.now() + '@example.com'); await op.fill('#r-pw', PW);
  await op.check('#r-terms'); await op.check('#r-age'); await op.click('#af-reg button[type=submit]');
  await op.waitForSelector('#af-codes:not([hidden])');
  const r2 = await other.request.get(BASE + fileUrl.split('?')[0]); assert.equal(r2.status(), 404);
  await anon.close(); await other.close();
});
await step('apagar o anexo (com confirmação) e o contador some da atividade', async () => {
  await page.click('#arq [data-up=del]'); await page.click('#arq [data-up=del]');
  await page.waitForFunction(() => /Nenhum arquivo/.test(document.querySelector('#arq-list').textContent));
  await page.click('#arq [data-up=arq-fechar]');
  await page.waitForFunction(() => document.querySelectorAll('#lista .arq-chip').length === 0);
});
await step('falha de conexão: mostra o erro, a atividade fica salva e "Tentar de novo" envia', async () => {
  await page.route('**/api/files', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
  await page.setInputFiles('#up-nova .up-input', [{ name: 'foto2.png', mimeType: 'image/png', buffer: PNG }]);
  await page.fill('#f-titulo', 'Trabalho sem internet'); await page.fill('#f-materia', 'Artes');
  await page.click('#form button[type=submit]');
  await page.waitForSelector('#up-nova .up-row.error');
  assert.match(await page.textContent('#up-nova .up-state'), /Sem conexão/);
  await page.unroute('**/api/files');
  await page.click('#up-nova [data-up=retry]');
  await page.waitForSelector('#up-nova .up-row.done');
  await page.waitForFunction(() => document.querySelectorAll('#lista .arq-chip').length === 1);
  assert.match(await page.textContent('#lista'), /Trabalho sem internet/);
});

await step('anexos em "Distribuição da nota": dois arquivos sobem junto com a distribuição, sem mexer nas notas', async () => {
  await page.click('#t-nova');
  await page.fill('#fd-materia', 'Física'); await page.fill('#f-dist', 'caderno 2, prova 4, trabalho 4');
  await page.setInputFiles('#up-dist .up-input', [
    { name: 'criterios.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'tabela.png', mimeType: 'image/png', buffer: PNG },
    { name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ-programa') },
  ]);
  assert.equal(await page.locator('#up-dist .up-row').count(), 2);
  assert.match(await page.textContent('#up-dist .up-msg'), /virus\.exe.*não é aceito/);
  assert.doesNotMatch(await page.textContent('#up-nova'), /criterios|tabela/, 'a caixa da atividade não recebe os arquivos da matéria');
  await page.screenshot({ path: join(SHOTS, '10-dist-previa.png'), fullPage: true });
  await page.click('#form-dist button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#up-dist .up-row.done').length === 2);
  await page.waitForFunction(() => /Enviados 2/.test(document.querySelector('#up-dist .pill').textContent));
  await page.screenshot({ path: join(SHOTS, '11-dist-enviado.png'), fullPage: true });
});
await step('aba Matérias: mostra "Anexos da matéria (2)", abre, baixa e a distribuição continua 2+4+4', async () => {
  await page.waitForFunction(() => /Salvo/.test(document.querySelector('#status').textContent));
  await page.reload(); await page.waitForSelector('#app:not([hidden])');
  await page.click('#t-mat');
  const det = page.locator('details.mat[data-key="física"]');
  await det.locator('summary').click();
  assert.match(await det.textContent(), /caderno/i); assert.match(await det.textContent(), /prova/i);
  assert.equal(await det.locator('.comp').count(), 3);
  const chip = det.locator('[data-up=mat-files]');
  assert.match(await chip.textContent(), /Anexos da matéria \(2\)/);
  await chip.click();
  await page.waitForSelector('#arq[open]');
  assert.match(await page.textContent('#arq-t'), /Física/);
  assert.match(await page.textContent('#arq-list'), /criterios\.pdf/); assert.match(await page.textContent('#arq-list'), /tabela\.png/);
  const href = await page.getAttribute('#arq-list a[download] >> nth=0', 'href');
  const r = await page.evaluate(async (u) => (await fetch(u)).status, href); assert.equal(r, 200);
  await page.screenshot({ path: join(SHOTS, '12-dist-janela.png') });
  await page.click('#arq [data-up=arq-fechar]');
});
await step('apagar um anexo da matéria (com confirmação) atualiza o contador', async () => {
  const det = page.locator('details.mat[data-key="física"]');
  await det.locator('[data-up=mat-files]').click();
  await page.click('#arq [data-up=del] >> nth=0'); await page.click('#arq [data-up=del] >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('#arq-list .up-row').length === 1);
  await page.click('#arq [data-up=arq-fechar]');
  await page.waitForFunction(() => /Anexos da matéria \(1\)/.test(document.querySelector('details.mat[data-key="física"]').textContent));
});

await step('sem erros de console e sem violações da política de segurança (CSP)', async () => {
  const v = await page.evaluate(() => window.__csp);
  assert.deepEqual(v, [], 'CSP: ' + JSON.stringify(v));
  assert.deepEqual(problems, [], problems.join(' | '));
});
await step('teclado: primeiro Tab vai para "Pular para o conteúdo"; abas operáveis por seta', async () => {
  await page.reload(); await page.waitForSelector('#app:not([hidden])');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
  await page.focus('#t-semana'); await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('#t-cal', 'aria-selected'), 'true');
});
await step('computador (largura 1100): layout e captura', async () => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click('#t-semana'); await page.screenshot({ path: join(SHOTS, '06-semana-desktop.png'), fullPage: true });
  await page.click('#t-nova'); await page.screenshot({ path: join(SHOTS, '10-nova-desktop.png'), fullPage: false });
});

await browser.close(); server.kill();
const bad = results.filter((r) => r[0] !== 'ok');
console.log(`\n${results.length - bad.length}/${results.length} etapas ok`);
process.exit(bad.length ? 1 : 0);
