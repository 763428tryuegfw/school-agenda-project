import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnv, makeClient } from './helpers.mjs';
import { scan } from '../scripts/scan-secrets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const PAGES = ['index.html', 'privacidade.html', 'termos.html', 'cookies.html'];

test('HTML: sem script embutido, sem atributos de evento, sem style="", sem javascript:', () => {
  for (const p of PAGES) {
    const html = rd('public/' + p);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc="[^"]+"/, `${p}: <script> sem src`);
      assert.equal(body.trim(), '', `${p}: script embutido`);
    }
    assert.ok(!/<style\b/i.test(html), `${p}: <style> embutido`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${p}: atributo style`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${p}: manipulador de evento embutido`);
    assert.ok(!/javascript:/i.test(html), `${p}: URL javascript:`);
    assert.ok(!/<(iframe|object|embed|form[^>]*action=)/i.test(html) || !/<(iframe|object|embed)/i.test(html), `${p}: iframe/object/embed`);
  }
});

test('HTML/CSS/JS: nenhum recurso externo (sem CDN, fontes ou rastreadores de terceiros)', () => {
  for (const p of PAGES) {
    const html = rd('public/' + p);
    for (const m of html.matchAll(/\b(?:src|href|action)="([^"]*)"/gi)) {
      assert.ok(!/^(https?:)?\/\//i.test(m[1]), `${p}: recurso externo ${m[1]}`);
    }
  }
  const css = rd('public/app.css');
  assert.ok(!/@import/i.test(css) && !/url\(\s*["']?(https?:)?\/\//i.test(css), 'CSS com recurso externo');
  for (const f of readdirSync(join(ROOT, 'public')).filter((x) => x.endsWith('.js'))) {
    const js = rd('public/' + f);
    assert.ok(!/\beval\s*\(|new Function\s*\(|document\.write\s*\(/.test(js), `${f}: eval/Function/document.write`);
    assert.ok(!/import\(\s*["']https?:/.test(js) && !/importScripts\(\s*["']https?:/.test(js), `${f}: import externo`);
    // todo fetch do front-end vai para a própria origem
    for (const m of js.matchAll(/fetch\(\s*["'`](https?:[^"'`]+)/g)) assert.fail(`${f}: fetch externo ${m[1]}`);
  }
});

test('JS: texto do usuário concatenado em HTML só aparece dentro de esc() ou de row() (que aplica esc() a todos os argumentos)', () => {
  const js = rd('public/app.js');
  assert.match(js, /const row=\(u,tag,main,sub\)=>[^\n]*esc\(tag\)[^\n]*esc\(main\)[^\n]*esc\(sub\)/, 'row() deve escapar tag, main e sub');
  const campos = ['titulo', 'materia', 'obs', 'nome', 'email', 'ua'];
  const soltos = [];
  js.split('\n').forEach((linha, n) => {
    for (const campo of campos) {
      if (new RegExp(`['"]\\s*\\+\\s*[A-Za-z_.]*\\.${campo}\\s*\\+\\s*['"]`).test(linha) && !/\brow\(/.test(linha)) soltos.push(`linha ${n + 1}: ${campo}`);
    }
  });
  assert.deepEqual(soltos, [], 'texto do usuário concatenado sem esc(): ' + soltos.join(' | '));
});

test('cabeçalhos de segurança no site e na API; API nunca é cacheada', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  for (const [path, api] of [['/', false], ['/app.js', false], ['/api/config', true], ['/api/auth/me', true], ['/api/nao-existe', true]]) {
    const r = await c.get(path);
    const h = r.headers;
    const csp = h.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/, path);
    assert.match(csp, /script-src 'self'(;|$)/, path);
    assert.match(csp, /style-src 'self'(;|$)/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /base-uri 'none'/, path);
    assert.match(csp, /object-src 'none'/, path);
    assert.match(csp, /form-action 'self'/, path);
    assert.ok(!/unsafe-inline|unsafe-eval|\*|data:|http:/.test(csp.replace(/;/g, ' ')), `${path}: CSP frouxa: ${csp}`);
    assert.equal(h.get('x-content-type-options'), 'nosniff', path);
    assert.equal(h.get('x-frame-options'), 'DENY', path);
    assert.equal(h.get('referrer-policy'), 'no-referrer', path);
    assert.match(h.get('strict-transport-security') || '', /max-age=\d{7,}/, path);
    assert.match(h.get('permissions-policy') || '', /camera=\(\)/, path);
    assert.equal(h.get('cross-origin-opener-policy'), 'same-origin', path);
    assert.equal(h.get('cross-origin-resource-policy'), 'same-origin', path);
    if (api) assert.equal(h.get('cache-control'), 'no-store', path);
  }
});

test('erros da API são genéricos (sem stack, caminho de arquivo ou detalhes internos)', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  for (const r of [await c.get('/api/nao-existe'), await c.req('POST', '/api/auth/login', undefined, { raw: '{quebrado', headers: { 'Content-Type': 'application/json' } }), await c.get('/api/sync')]) {
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    assert.ok(!/at .*\(|\.js:\d+|node_modules|\/home\/|Error:/.test(r.text), r.text);
  }
  assert.equal((await c.req('POST', '/api/auth/login', { email: 'a@b.co', password: 'x' }, { origin: 'https://evil.example' })).status, 403, 'CSRF: origem estranha');
  assert.equal((await c.req('POST', '/api/auth/login', undefined, { raw: 'email=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status >= 400, true, 'formulário comum não é aceito');
  assert.equal((await c.req('DELETE', '/')).status, 405);
});

test('manifesto PWA: ícones existem com o tamanho declarado, incluindo o maskable', () => {
  const m = JSON.parse(rd('public/manifest.webmanifest'));
  assert.ok(m.name && m.short_name && m.start_url && m.scope && m.display);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
  for (const i of m.icons) {
    const file = join(ROOT, 'public', i.src.replace(/^\.\//, ''));
    assert.ok(existsSync(file), `ícone ausente: ${i.src}`);
    const buf = readFileSync(file);
    assert.equal(buf.slice(1, 4).toString(), 'PNG');
    const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    assert.equal(`${w}x${h}`, i.sizes, `${i.src}: tamanho real ${w}x${h}`);
  }
  const html = rd('public/index.html');
  for (const rel of ['apple-touch-icon.png', 'favicon-32.png']) assert.ok(html.includes(rel) && existsSync(join(ROOT, 'public', rel)), rel);
});

test('service worker: arquivos do cache existem, API nunca é cacheada', () => {
  const sw = rd('public/sw.js');
  const core = sw.match(/CORE\s*=\s*\[([\s\S]*?)\]/)[1];
  const files = [...core.matchAll(/['"]\.\/([^'"]*)['"]/g)].map((x) => x[1]).filter(Boolean);
  assert.ok(files.length >= 8);
  for (const f of files) assert.ok(existsSync(join(ROOT, 'public', f)), `SW cacheia arquivo que não existe: ${f}`);
  assert.match(sw, /\/api\//, 'SW precisa tratar /api/ de forma especial');
  assert.match(sw, /addEventListener\(\s*['"]push['"]/);
  assert.match(sw, /addEventListener\(\s*['"]notificationclick['"]/);
});

test('páginas legais existem, citam a LGPD e apontam umas para as outras', () => {
  const p = rd('public/privacidade.html'), t = rd('public/termos.html'), c = rd('public/cookies.html');
  assert.match(p, /LGPD|13\.709/);
  assert.match(p, /exclu/i); assert.match(p, /exporta|baixar|portabilidade/i);
  assert.match(t, /idade|13 anos|responsável/i);
  assert.match(c, /cookie/i);
  for (const html of [p, t, c, rd('public/index.html')]) assert.match(html, /privacidade\.html/);
});

test('privacidade: cobre anexos, nome de arquivo, retenção, exportação sem conteúdo, exclusão e pedido de ajuda; sem inventar responsável', () => {
  const p = rd('public/privacidade.html');
  for (const re of [/Arquivos anexados/, /nome do arquivo/, /Limites por conta/, /conteúdo dos anexos não vai dentro do JSON/, /Excluir minha conta/, /Apagar uma atividade não apaga/, /data-contact/, /data-controller/, /Histórico de versões|histórico de versões/]) assert.match(p, re, String(re));
  assert.match(p, /Não pedimos nome/);
  assert.doesNotMatch(p, /[\w.+-]+@(?!example)[\w-]+\.[a-z]{2,}/i, 'nenhum e-mail real escrito no texto');
  const legal = rd('public/legal.js');
  assert.match(legal, /ainda não informado/);
});

test('cookies: aviso real com Aceitar e Recusar iguais, escolha só local, nada de terceiros', () => {
  const js = rd('public/consent.js'), c = rd('public/cookies.html');
  assert.match(js, /Aceitar opcionais/); assert.match(js, /Recusar opcionais/);
  assert.equal((js.match(/className|el\('button', 'consent-btn'/g) || []).length > 0, true);
  assert.equal((js.match(/'consent-btn'/g) || []).length, 2, 'os dois botões usam exatamente a mesma classe');
  assert.doesNotMatch(js, /https?:\/\/|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon/, 'o aviso não chama rede nem grava cookie');
  assert.match(js, /optionalAllowed/);
  for (const f of ['index.html', 'privacidade.html', 'termos.html', 'cookies.html']) {
    const h = rd('public/' + f); assert.match(h, /consent\.js/, f); assert.match(h, /data-consent="open"/, f);
  }
  assert.match(c, /agenda-cookies/); assert.match(c, /Hoje não usamos nenhum cookie ou rastreador opcional/);
  assert.match(rd('public/sw.js'), /consent\.js/);
});

test('publicação: wrangler serve a página 404 com status 404 e a página existe com link de volta', () => {
  const w = rd('wrangler.jsonc'), h = rd('public/404.html');
  assert.match(w, /"not_found_handling"\s*:\s*"404-page"/);
  assert.match(h, /Página não encontrada/); assert.match(h, /name="robots" content="noindex"/); assert.match(h, /href="\/"/);
  assert.match(h, /href="\/app\.css"/, '404 usa caminhos absolutos: funciona em /a/b/c');
});

test('configuração: wrangler.jsonc sem segredos, com Durable Object SQLite, cron e Worker na frente dos arquivos', () => {
  const raw = rd('wrangler.jsonc');
  const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1').replace(/(\S)\s+\/\/ .*$/gm, '$1'));
  assert.equal(cfg.name, 'school-agenda-project');
  assert.equal(cfg.assets.run_worker_first, true);
  assert.equal(cfg.assets.binding, 'ASSETS');
  assert.deepEqual(cfg.durable_objects.bindings[0], { name: 'DB', class_name: 'AppDB' });
  assert.deepEqual(cfg.migrations[0].new_sqlite_classes, ['AppDB']);
  assert.ok(cfg.triggers.crons.length === 1);
  for (const k of Object.keys(cfg.vars)) assert.ok(!/PEPPER|PRIVATE|SECRET|API_KEY|PASSWORD|TOKEN/i.test(k), `segredo em vars: ${k}`);
  const gi = rd('.gitignore');
  for (const line of ['.dev.vars', '.env', 'node_modules/', '*.sqlite', '.wrangler/']) assert.ok(gi.includes(line), `.gitignore sem ${line}`);
});

test('varredura de segredos no repositório', () => {
  assert.deepEqual(scan(ROOT), []);
});

// ---- contraste (WCAG 2.1 AA: texto normal 4,5:1) entre as cores de texto e de fundo usadas pelo CSS
test('contraste de cores de texto atende WCAG AA (4,5:1)', () => {
  const css = rd('public/app.css');
  const tokens = {};
  for (const m of css.match(/:root\{([^}]*)\}/)[1].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) tokens[m[1]] = m[2];
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(tokens[a]), y = lum(tokens[b]); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const pairs = [['ink', 'bg'], ['ink', 'card'], ['ink', 'raise'], ['muted', 'bg'], ['muted', 'card'], ['muted', 'raise'], ['navy', 'bg'], ['navy', 'card'], ['navy', 'raise'],
    ['on-navy', 'navy'], ['on-blue', 'blue'], ['on-red', 'red'], ['red-ink', 'red-soft'], ['blue-ink', 'blue-soft'], ['yel', 'yel-soft'], ['on-yel', 'yel-fill'],
    ['teal-ink', 'lime-soft'], ['sage', 'lime-soft'], ['ink', 'lime'], ['red-ink', 'card'], ['blue-ink', 'card'], ['teal-ink', 'card'], ['yel', 'card'], ['muted', 'soft']];
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${fg} sobre ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  // Tons só decorativos (pontos, bordas) não podem ser usados como cor de texto
  for (const t of ['red', 'blue', 'teal', 'line']) assert.ok(!new RegExp(`[^-]color:var\\(--${t}\\)`).test(css), `--${t} usado como cor de texto, mas não tem contraste suficiente`);
});
