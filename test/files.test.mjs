// Etapa 1 do upload: servidor que recebe, valida, guarda e entrega arquivos. Sem tela ainda.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, makeClient, register, GOOD_PW, ORIGIN } from './helpers.mjs';
import { detectFile, safeName, parseRange, fileLimits, contentDisposition, CHUNK_BYTES } from '../src/files.js';
import { sha256Hex } from '../src/util.js';

const enc = (s) => new TextEncoder().encode(s);
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const rnd = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
const FIX = {
  jpg: (n = 300) => cat(Uint8Array.of(0xFF, 0xD8, 0xFF, 0xE0), rnd(n)),
  png: (n = 300) => cat(Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), rnd(n)),
  gif: () => cat(enc('GIF89a'), rnd(100)),
  webp: () => cat(enc('RIFF'), rnd(4), enc('WEBP'), rnd(50)),
  pdf: () => cat(enc('%PDF-1.7\n'), rnd(200)),
  mp4: (n = 500) => cat(Uint8Array.of(0, 0, 0, 0x18), enc('ftypisom'), rnd(n)),
  mov: () => cat(Uint8Array.of(0, 0, 0, 0x14), enc('ftypqt  '), rnd(100)),
  webm: () => cat(Uint8Array.of(0x1A, 0x45, 0xDF, 0xA3), rnd(100)),
  heic: () => cat(Uint8Array.of(0, 0, 0, 0x18), enc('ftypheic'), rnd(100)),
  docx: () => cat(Uint8Array.of(0x50, 0x4B, 3, 4), rnd(200)),
  txt: () => enc('Anotações da aula: capítulo 3\nrevisar exercícios.'),
};

const up = (c, bytes, name, h = {}) => {
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-File-Name': encodeURIComponent(name), 'X-Scope': 'materia', 'X-Materia': encodeURIComponent('Matemática'), ...h };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  return c.req('POST', '/api/files', undefined, { raw: bytes, headers });
};
const upItem = (c, bytes, name, itemId, h = {}) => up(c, bytes, name, { 'X-Scope': 'item', 'X-Item-Id': itemId, 'X-Materia': undefined, ...h });
const item = (id, o = {}) => ({ id, titulo: 'Trabalho ' + id, materia: 'História', tipo: 'entrega', data: '2026-10-25', ...o });
let n = 0;
const user = async (env, extra = {}) => { const c = makeClient(env, { ip: `198.51.100.${++n}`, ...extra }); await register(c); return c; };
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

test('enviar, listar, abrir e baixar: os bytes voltam idênticos (arquivo de vários pedaços)', async () => {
  const { env, db } = makeEnv();
  const c = await user(env);
  const bytes = FIX.png(CHUNK_BYTES * 2 + 12345);                 // 3 pedaços
  const r = await up(c, bytes, 'foto da prova.png');
  assert.equal(r.status, 201, r.text);
  const f = r.json.file;
  assert.deepEqual({ scope: f.scope, itemId: f.itemId, materia: f.materia, name: f.name, kind: f.kind, mime: f.mime, inline: f.inline, size: f.size },
    { scope: 'materia', itemId: null, materia: 'Matemática', name: 'foto da prova.png', kind: 'image', mime: 'image/png', inline: true, size: bytes.length });
  assert.match(f.id, /^[A-Za-z0-9_-]{22}$/, 'nome interno aleatório, sem relação com o nome enviado');
  assert.equal(db.prepare('SELECT chunks FROM files').get().chunks, 3);
  assert.equal(db.prepare('SELECT sha256 FROM files').get().sha256, await sha256Hex(bytes));

  const list = await c.get('/api/files');
  assert.equal(list.json.files.length, 1);
  assert.deepEqual(list.json.usage, { count: 1, bytes: bytes.length });
  assert.equal(list.json.limits.maxFileBytes, 20 * 1024 * 1024);

  const d = await c.get('/api/files/' + f.id);
  assert.equal(d.status, 200);
  assert.deepEqual(d.bytes, bytes);
  assert.equal(d.headers.get('content-type'), 'image/png');
  assert.match(d.headers.get('content-disposition'), /^inline; filename="foto da prova.png"/);
  assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(d.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(d.headers.get('cache-control'), 'no-store');
  assert.equal(d.headers.get('accept-ranges'), 'bytes');
  const dl = await c.get('/api/files/' + f.id + '?download=1');
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
});

test('persistência: depois de "reiniciar" o servidor (novo ambiente sobre o mesmo banco) o arquivo continua lá', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenda-'));
  const file = join(dir, 'db.sqlite');
  try {
    const a = makeEnv({}, file);
    const c1 = await user(a.env);
    const bytes = FIX.pdf();
    const f = (await up(c1, bytes, 'resumo.pdf')).json.file;
    const cookie = [...c1.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    a.db.close();
    const b = makeEnv({}, file);
    const c2 = makeClient(b.env, { ip: '198.51.100.99' });
    const d = await c2.get('/api/files/' + f.id, { cookie });
    assert.equal(d.status, 200);
    assert.deepEqual(d.bytes, bytes);
    b.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('arquivo de uma atividade: matéria vem do servidor; apagar a atividade não apaga o arquivo', async () => {
  const { env, db } = makeEnv();
  const c = await user(env);
  await c.post('/api/sync', { items: { upsert: [item('i1')] } });
  const r = await upItem(c, FIX.jpg(), 'capa.jpg', 'i1', { 'X-Materia': encodeURIComponent('Outra matéria que o navegador inventou') });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual({ scope: r.json.file.scope, itemId: r.json.file.itemId, materia: r.json.file.materia }, { scope: 'item', itemId: 'i1', materia: 'História' });
  await c.post('/api/sync', { items: { delete: ['i1'] } });
  const l = (await c.get('/api/files')).json.files;
  assert.equal(l.length, 1, 'o arquivo continua guardado');
  assert.deepEqual({ scope: l[0].scope, itemId: l[0].itemId, materia: l[0].materia }, { scope: 'materia', itemId: null, materia: 'História' });
  assert.equal(count(db, 'file_chunks'), 1);
  // atividade que não existe, ou que é de outra pessoa
  assert.equal((await upItem(c, FIX.jpg(), 'x.jpg', 'nao-existe')).status, 404);
  const b = await user(env);
  await b.post('/api/sync', { items: { upsert: [item('b1')] } });
  const r2 = await upItem(c, FIX.jpg(), 'x.jpg', 'b1');
  assert.equal(r2.status, 404, 'não dá para anexar na atividade de outra conta');
  assert.equal((await b.get('/api/files')).json.files.length, 0);
});

test('permissões: sem sessão nada funciona; outra conta não vê, baixa nem apaga', async () => {
  const { env, db } = makeEnv();
  const anon = makeClient(env);
  const a = await user(env), b = await user(env);
  const f = (await up(a, FIX.pdf(), 'segredo.pdf')).json.file;
  assert.equal((await anon.get('/api/files')).status, 401);
  assert.equal((await anon.get('/api/files/' + f.id)).status, 401);
  assert.equal((await up(anon, FIX.pdf(), 'x.pdf')).status, 401);
  assert.equal((await anon.req('DELETE', '/api/files/' + f.id)).status, 401);
  assert.equal((await b.get('/api/files/' + f.id)).status, 404);
  assert.equal((await b.get('/api/files/' + f.id + '?download=1')).status, 404);
  assert.equal((await b.req('DELETE', '/api/files/' + f.id)).status, 404);
  assert.equal((await b.get('/api/files')).json.files.length, 0);
  assert.equal((await a.get('/api/files/' + f.id)).status, 200, 'o dono continua com acesso');
  assert.equal(count(db, 'files'), 1);
  // id inexistente ou malformado
  assert.equal((await a.get('/api/files/' + 'a'.repeat(22))).status, 404);
  assert.equal((await a.get('/api/files/..%2F..%2Fetc')).status, 404);
  assert.equal((await a.get('/api/files/' + 'a'.repeat(41))).status, 404);
});

test('CSRF: pedido que muda arquivos vindo de outro site é recusado', async () => {
  const { env } = makeEnv();
  const a = await user(env);
  const f = (await up(a, FIX.pdf(), 'a.pdf')).json.file;
  const bytes = FIX.jpg();
  const evil = await a.req('POST', '/api/files', undefined, { origin: 'https://evil.example', raw: bytes, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-File-Name': 'a.jpg', 'X-Scope': 'materia', 'X-Materia': 'X' } });
  assert.equal(evil.status, 403);
  assert.equal((await a.req('DELETE', '/api/files/' + f.id, undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.req('DELETE', '/api/files/' + f.id, undefined, { origin: null })).status, 403, 'sem Origin e sem Sec-Fetch-Site também não vale');
  assert.equal((await a.get('/api/files')).json.files.length, 1);
});

test('tipos aceitos (foto, pdf, vídeo, documento, texto): o servidor decide o tipo pelo conteúdo', async () => {
  const { env } = makeEnv();
  const c = await user(env);
  const casos = [
    [FIX.jpg(), 'a.JPG', 'image', 'image/jpeg', true], [FIX.png(), 'a.png', 'image', 'image/png', true], [FIX.gif(), 'a.gif', 'image', 'image/gif', true],
    [FIX.webp(), 'a.webp', 'image', 'image/webp', true], [FIX.heic(), 'IMG_1.HEIC', 'image', 'image/heic', false], [FIX.pdf(), 'a.pdf', 'pdf', 'application/pdf', false],
    [FIX.mp4(), 'a.mp4', 'video', 'video/mp4', true], [FIX.mov(), 'a.mov', 'video', 'video/quicktime', true], [FIX.mp4(), 'IMG_2.MOV', 'video', 'video/quicktime', true],
    [FIX.webm(), 'a.webm', 'video', 'video/webm', true], [FIX.docx(), 'a.docx', 'doc', 'application/octet-stream', false], [FIX.txt(), 'a.txt', 'text', 'text/plain; charset=utf-8', false],
  ];
  for (const [bytes, name, kind, mime, inline] of casos) {
    const r = await up(c, bytes, name);
    assert.equal(r.status, 201, `${name}: ${r.text}`);
    assert.deepEqual([r.json.file.kind, r.json.file.mime, r.json.file.inline], [kind, mime, inline], name);
  }
  // quem não é "inline" (PDF, documentos, texto, HEIC) sempre baixa, mesmo sem pedir
  const pdf = (await c.get('/api/files')).json.files.find((f) => f.kind === 'pdf');
  assert.match((await c.get('/api/files/' + pdf.id)).headers.get('content-disposition'), /^attachment;/);
});

test('arquivos inválidos ou perigosos são recusados (415) e nada é guardado', async () => {
  const { env, db } = makeEnv();
  const c = await user(env);
  const ruins = [
    [enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.svg'],
    [enc('<html><script>alert(1)</script></html>'), 'x.html'],
    [enc('<html><script>alert(1)</script></html>'), 'foto.jpg'],        // HTML disfarçado de foto
    [enc('MZ\x90\x00\x03\x00\x00\x00'), 'foto.jpg'],                    // executável disfarçado
    [enc('MZ\x90\x00\x03\x00\x00\x00'), 'setup.exe'],
    [FIX.pdf(), 'foto.jpg'], [FIX.jpg(), 'doc.pdf'], [FIX.png(), 'v.mp4'],  // conteúdo não combina com a extensão
    [FIX.jpg(), 'semextensao'], [FIX.jpg(), 'foto.'], [FIX.jpg(), 'foto.exe'],
    [enc('console.log(1)'), 'a.js'], [enc('<?php echo 1;'), 'a.php'], [enc('echo oi'), 'a.sh'],
    [cat(Uint8Array.of(0x50, 0x4B, 3, 4), rnd(50)), 'a.zip'], [cat(Uint8Array.of(0x50, 0x4B, 3, 4), rnd(50)), 'a.jar'],
    [cat(enc('texto'), Uint8Array.of(0), enc('com nulo')), 'a.txt'],      // binário chamado .txt
    [Uint8Array.of(0xFF, 0xFE, 0xFD, 0x80, 0x81), 'a.txt'],               // UTF-8 inválido
    [Uint8Array.of(1, 2), 'a.png'], [enc('abc'), 'a.png'],
  ];
  for (const [bytes, name] of ruins) {
    const r = await up(c, bytes, name);
    assert.equal(r.status, 415, `${name} deveria ser recusado: ${r.status} ${r.text}`);
    assert.equal(r.json.error, 'unsupported_file_type');
  }
  assert.equal(count(db, 'files'), 0);
  assert.equal(count(db, 'file_chunks'), 0);
});

test('cabeçalhos do envio: tamanho, tipo de conteúdo, escopo, nomes e matéria', async () => {
  const { env } = makeEnv({ MAX_FILE_MB: '1' });
  const c = await user(env);
  const big = FIX.jpg(1024 * 1024);
  assert.equal((await up(c, big, 'grande.jpg')).status, 413, 'maior que o limite de 1 MB');
  assert.equal((await up(c, FIX.jpg(1024 * 1024 - 10), 'quase.jpg')).status, 201, 'dentro do limite');
  // mentir sobre o tamanho (corpo maior ou menor que o declarado)
  const b = FIX.jpg();
  assert.equal((await up(c, b, 'a.jpg', { 'Content-Length': String(b.length - 5) })).status, 400);
  assert.equal((await up(c, b, 'a.jpg', { 'Content-Length': String(b.length + 5) })).status, 400);
  assert.equal((await up(c, b, 'a.jpg', { 'Content-Length': undefined })).status, 411);
  assert.equal((await up(c, new Uint8Array(0), 'a.jpg')).status, 400);
  assert.equal((await up(c, b, 'a.jpg', { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await up(c, b, 'a.jpg', { 'Content-Type': 'image/jpeg' })).status, 415);
  assert.equal((await up(c, b, 'a.jpg', { 'X-Scope': 'admin' })).status, 400);
  assert.equal((await up(c, b, 'a.jpg', { 'X-Scope': undefined })).status, 400);
  assert.equal((await up(c, b, '   ')).status, 400);
  assert.equal((await up(c, b, 'a.jpg', { 'X-File-Name': '%E0%A4%A' })).status, 400, 'nome com codificação quebrada');
  assert.equal((await up(c, b, 'a.jpg', { 'X-Materia': undefined })).status, 400, 'matéria obrigatória');
  assert.equal((await up(c, b, 'a.jpg', { 'X-Materia': encodeURIComponent('x'.repeat(41)) })).status, 400);
  assert.equal((await up(c, b, 'a.jpg', { 'X-Materia': encodeURIComponent('Mat\u0000') })).status, 400);
  assert.equal((await upItem(c, b, 'a.jpg', '../x')).status, 400);
  assert.equal((await up(c, b, 'a'.repeat(301) + '.jpg')).status, 400);
});

test('nome do arquivo é higienizado (sem caminho, sem controle, sem inversão de texto)', async () => {
  const { env } = makeEnv();
  const c = await user(env);
  const nome = async (raw) => (await up(c, FIX.jpg(), raw)).json.file.name;
  assert.equal(await nome('../../etc/passwd.jpg'), '_.._etc_passwd.jpg');
  assert.equal(await nome('C:\\Users\\aluno\\foto.jpg'), 'C__Users_aluno_foto.jpg');
  assert.equal(await nome('foto\u202Egpj.jpg'), 'fotogpj.jpg');
  assert.equal(await nome('a\nb\t c.jpg'), 'ab c.jpg');
  assert.equal(await nome('.htaccess.jpg'), 'htaccess.jpg');
  assert.equal(await nome('<script>.jpg'), '_script_.jpg');
  const longo = await nome('x'.repeat(200) + '.jpg');
  assert.ok(longo.length <= 100 && longo.endsWith('.jpg'));
  assert.equal(await nome('Relatório de História – 2º bimestre.jpg'), 'Relatório de História – 2º bimestre.jpg');
  assert.equal(safeName('', 'png'), 'arquivo.png');
  assert.equal(safeName('.png', 'png'), 'arquivo.png');
  const cd = contentDisposition('attachment', 'Relatório "final".pdf');
  assert.ok(!/[^\x20-\x7E]/.test(cd) && cd.includes("filename*=UTF-8''Relat%C3%B3rio"), cd);
});

test('Range (vídeo no Safari/iPhone exige): trechos, fim aberto, últimos N bytes, atravessando pedaços, inválido = 416', async () => {
  const { env } = makeEnv();
  const c = await user(env);
  const bytes = FIX.mp4(CHUNK_BYTES * 2 + 1000);
  const f = (await up(c, bytes, 'aula.mp4')).json.file;
  const get = (range) => c.get('/api/files/' + f.id, { headers: { Range: range } });
  let r = await get('bytes=0-99');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 0-99/${bytes.length}`);
  assert.deepEqual(r.bytes, bytes.slice(0, 100));
  r = await get(`bytes=${CHUNK_BYTES - 10}-${CHUNK_BYTES + 10}`);
  assert.deepEqual(r.bytes, bytes.slice(CHUNK_BYTES - 10, CHUNK_BYTES + 11), 'atravessa a divisa entre dois pedaços');
  r = await get(`bytes=${bytes.length - 500}-`);
  assert.deepEqual(r.bytes, bytes.slice(bytes.length - 500));
  r = await get('bytes=-300');
  assert.deepEqual(r.bytes, bytes.slice(bytes.length - 300));
  r = await get(`bytes=0-${bytes.length * 2}`);
  assert.equal(r.status, 206); assert.equal(r.bytes.length, bytes.length);
  for (const ruim of [`bytes=${bytes.length}-`, 'bytes=5-2', 'bytes=-0', 'bytes=a-b', 'items=0-1', 'bytes=0-1,5-9']) {
    const x = await get(ruim);
    assert.equal(x.status, 416, ruim);
    assert.equal(x.headers.get('content-range'), `bytes */${bytes.length}`);
  }
  assert.deepEqual(parseRange(undefined, 10), null);
});

test('apagar: remove metadados e conteúdo, libera a cota; só o dono apaga', async () => {
  const { env, db } = makeEnv();
  const c = await user(env);
  const f = (await up(c, FIX.png(CHUNK_BYTES + 5), 'a.png')).json.file;
  assert.equal(count(db, 'file_chunks'), 2);
  const del = await c.req('DELETE', '/api/files/' + f.id);
  assert.equal(del.status, 200);
  assert.equal((await c.get('/api/files/' + f.id)).status, 404);
  assert.equal(count(db, 'files'), 0);
  assert.equal(count(db, 'file_chunks'), 0);
  assert.deepEqual((await c.get('/api/files')).json.usage, { count: 0, bytes: 0 });
  assert.equal((await c.req('DELETE', '/api/files/' + f.id)).status, 404, 'já apagado');
  assert.equal((await c.req('PUT', '/api/files/' + f.id, {})).status, 405);
  assert.equal((await c.req('PUT', '/api/files', {})).status, 405);
});

test('cotas: por conta, por atividade, por quantidade e limite de envios por hora', async () => {
  const { env, store } = makeEnv({ MAX_FILE_MB: '6', ACCOUNT_QUOTA_MB: '10' });
  const c = await user(env);
  const seis = FIX.mp4(6 * 1024 * 1024 - 100);
  assert.equal((await up(c, seis, 'a.mp4')).status, 201);
  const r = await up(c, seis, 'b.mp4');
  assert.equal(r.status, 422); assert.equal(r.json.error, 'quota_exceeded');
  assert.equal((await up(c, FIX.jpg(), 'pequena.jpg')).status, 201, 'cabe no que sobrou');
  // 10 por atividade
  const d = await user(env);
  await d.post('/api/sync', { items: { upsert: [item('t1')] } });
  for (let i = 0; i < 10; i++) assert.equal((await upItem(d, FIX.jpg(), `f${i}.jpg`, 't1')).status, 201);
  const mais = await upItem(d, FIX.jpg(), 'f11.jpg', 't1');
  assert.equal(mais.status, 422); assert.equal(mais.json.error, 'too_many_item_files');
  // quantidade total (direto no banco, para não depender do limite por hora)
  const u = store.one('SELECT id FROM users LIMIT 1').id;
  const lim = { ...fileLimits({}), maxFiles: 1 };
  assert.equal(store.addFile(u, { id: 'zzzzzzzzzzzzzzzzzzzzzz', scope: 'materia', materia: 'X', name: 'a.jpg', kind: 'image', mime: 'image/jpeg', inline: true, sha256: 'x' }, FIX.jpg().buffer, lim, 1).error, 'too_many_files');
  // limite de envios por hora (60)
  const e = await user(env);
  let ultimo;
  for (let i = 0; i < 61; i++) { ultimo = await up(e, FIX.txt(), 'a.txt'); if (ultimo.status === 429) break; }
  assert.equal(ultimo.status, 429);
});

test('enviar é tudo-ou-nada: falha no meio não deixa pedaços soltos', async () => {
  const { env, store, db } = makeEnv();
  await user(env);
  const u = store.one('SELECT id FROM users LIMIT 1').id;
  const meta = { id: 'aaaaaaaaaaaaaaaaaaaaaa', scope: 'materia', materia: 'X', name: 'a.png', kind: 'image', mime: 'image/png', inline: true, sha256: 'x' };
  const bytes = FIX.png(CHUNK_BYTES * 2).buffer;
  assert.equal(store.addFile(u, meta, bytes, fileLimits({}), 1).ok, true);
  assert.throws(() => store.addFile(u, meta, bytes, fileLimits({}), 1));      // mesmo id: viola a chave primária no meio
  assert.equal(count(db, 'files'), 1);
  assert.equal(count(db, 'file_chunks'), 3);
});

test('excluir a conta apaga arquivos e conteúdo; exportar lista os arquivos sem os bytes; auditoria sem nomes', async () => {
  const { env, db } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.201' });
  await register(a);
  const b = await user(env);
  await up(a, FIX.pdf(), 'diario-secreto.pdf');
  await up(b, FIX.pdf(), 'do-beto.pdf');
  const ex = await a.get('/api/account/export');
  assert.ok(ex.text.includes('diario-secreto.pdf') && !ex.text.includes('do-beto.pdf'));
  assert.equal(JSON.parse(ex.text).arquivos_enviados.length, 1);
  const ev = db.prepare('SELECT event, detail FROM audit WHERE event LIKE ?').all('file_%');
  assert.ok(ev.length >= 2 && !JSON.stringify(ev).includes('diario'), 'auditoria sem nome de arquivo');
  const del = await a.post('/api/account/delete', { password: GOOD_PW, confirm: 'EXCLUIR' });
  assert.equal(del.status, 200);
  assert.equal(count(db, 'files'), 1);
  assert.equal(count(db, 'file_chunks'), 1, 'só sobrou o do Beto');
  assert.equal((await b.get('/api/files')).json.files.length, 1);
});

test('detectFile / parseRange / fileLimits (unidade)', () => {
  assert.equal(detectFile(FIX.jpg(), 'a.jpg').id, 'jpeg');
  assert.equal(detectFile(FIX.jpg(), 'a.png'), null);
  assert.equal(detectFile(new Uint8Array(0), 'a.jpg'), null);
  assert.equal(detectFile(FIX.txt(), 'a.csv').kind, 'text');
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=2-', 10), { start: 2, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(parseRange('bytes=10-12', 10), 'invalid');
  assert.deepEqual(fileLimits({}), { maxFileBytes: 20971520, accountBytes: 104857600, maxFiles: 100, maxItemFiles: 10 });
  assert.equal(fileLimits({ MAX_FILE_MB: '9999' }).maxFileBytes, 25 * 1024 * 1024);
  assert.equal(fileLimits({ MAX_FILE_MB: 'lixo' }).maxFileBytes, 20 * 1024 * 1024);
  assert.equal(ORIGIN, 'https://agenda.test');
});
