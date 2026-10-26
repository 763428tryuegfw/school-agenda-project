import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClient, register, uniqueEmail, GOOD_PW, advance, clock, ORIGIN } from './helpers.mjs';
import { hotp, base32Decode } from '../src/totp.js';

const DAY = 864e5, MIN = 60e3;

async function login(c, email, password = GOOD_PW, extra = {}) { return c.post('/api/auth/login', { email, password, ...extra }); }

test('cadastro: validações no servidor', async () => {
  const { env } = makeEnv();
  let k = 0;
  // cada tentativa vem de um IP diferente: o limite de cadastros é por IP e conta até as tentativas inválidas
  const post = (body) => makeClient(env, { ip: `192.0.2.${++k}` }).post('/api/auth/register', body);
  const base = { email: uniqueEmail(), password: GOOD_PW, acceptTerms: true, confirmAge: true };
  assert.equal((await post({ ...base, email: 'sem-arroba' })).json.error, 'invalid_email');
  assert.equal((await post({ ...base, email: 'a@b' })).json.error, 'invalid_email');
  assert.equal((await post({ ...base, email: 12345 })).json.error, 'invalid_email');
  assert.equal((await post({ ...base, password: 'curta' })).json.error, 'password_too_short');
  assert.equal((await post({ ...base, password: '1234567890' })).json.error, 'password_too_common');
  assert.equal((await post({ ...base, password: { $ne: 1 } })).json.error, 'invalid_password');
  assert.equal((await post({ ...base, acceptTerms: false })).json.error, 'terms_required');
  assert.equal((await post({ ...base, acceptTerms: 'true' })).json.error, 'terms_required');
  assert.equal((await post({ ...base, confirmAge: false })).json.error, 'age_required');
  assert.equal((await post({ ...base, confirmAge: undefined })).json.error, 'age_required');
  const ok = await post(base);
  assert.equal(ok.status, 201);
});

test('cadastro: e-mail é normalizado e duplicado dá resposta neutra', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.1' }), b = makeClient(env, { ip: '198.51.100.2' });
  const r1 = await a.post('/api/auth/register', { email: '  Maria@Example.COM ', password: GOOD_PW, acceptTerms: true, confirmAge: true });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.user.email, 'maria@example.com');
  const r2 = await b.post('/api/auth/register', { email: 'maria@example.com', password: GOOD_PW, acceptTerms: true, confirmAge: true });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error, 'account_unavailable');
  assert.equal(b.jar.size, 0, 'não cria sessão');
});

test('senha nunca é guardada nem devolvida em texto puro; cookie de sessão tem os atributos de segurança', async () => {
  const { env, db } = makeEnv();
  const c = makeClient(env);
  const secretPw = 'Senha-Unica-Para-Procurar-777';
  const r = await register(c, uniqueEmail(), secretPw);
  assert.ok(!r.text.includes(secretPw));
  const sc = r.cookies[0];
  assert.match(sc, /^__Host-sid=[A-Za-z0-9_-]{43};/);
  for (const attr of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(sc.includes(attr), attr);
  assert.ok(!/Domain=/i.test(sc), '__Host- exige cookie sem Domain');
  const dump = JSON.stringify(['users', 'sessions', 'audit', 'recovery_codes', 'rate_limits'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
  assert.ok(!dump.includes(secretPw), 'senha em texto puro encontrada no banco');
  const token = /__Host-sid=([^;]+)/.exec(sc)[1];
  assert.ok(!dump.includes(token), 'token de sessão guardado em texto puro');
  assert.match(db.prepare('SELECT pw_hash FROM users').get().pw_hash, /^pbkdf2-sha512\$100000\$/);
});

test('login: erro genérico igual para e-mail inexistente e senha errada', async () => {
  const { env } = makeEnv();
  const a = makeClient(env);
  const { email } = await register(a);
  const c = makeClient(env, { ip: '198.51.100.9' });
  const wrong = await login(c, email, 'Senha-Errada-12345');
  const ghost = await login(c, 'ninguem@example.com');
  assert.equal(wrong.status, 401); assert.equal(ghost.status, 401);
  assert.deepEqual(wrong.json, ghost.json);
  assert.equal(wrong.json.error, 'invalid_credentials');
});

test('login: sessão nova a cada entrada, logout invalida o cookie antigo', async () => {
  const { env } = makeEnv();
  const a = makeClient(env);
  const { email } = await register(a);
  const first = a.jar.get('__Host-sid');
  const b = makeClient(env, { ip: '198.51.100.3' });
  assert.equal((await login(b, email)).status, 200);
  const second = b.jar.get('__Host-sid');
  assert.notEqual(first, second);
  // reapresentar um token qualquer/forjado não autentica
  assert.equal((await b.get('/api/auth/me', { cookie: '__Host-sid=' + 'A'.repeat(43) })).status, 401);
  assert.equal((await b.get('/api/auth/me', { cookie: '__Host-sid=lixo' })).status, 401);
  const stolen = second;
  b.jar.set('__Host-sid', second);   // (o pedido com cookie forjado acima limpou o cookie do "navegador" de teste)
  assert.equal((await b.post('/api/auth/logout')).status, 200);
  assert.equal((await b.get('/api/auth/me', { cookie: '__Host-sid=' + stolen })).status, 401, 'token antigo não vale depois do logout');
  assert.equal((await a.get('/api/auth/me')).status, 200, 'o outro aparelho continua conectado');
});

test('sessão expira por inatividade (14 dias) e no máximo em 60 dias; uso renova a inatividade', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  await register(c);
  advance(10 * DAY);
  assert.equal((await c.get('/api/auth/me')).status, 200);          // renova "último uso"
  advance(10 * DAY);
  assert.equal((await c.get('/api/auth/me')).status, 200);          // 10 dias desde o último uso: ok
  advance(15 * DAY);
  assert.equal((await c.get('/api/auth/me')).status, 401);          // 15 dias parado: expirou
  const d = makeClient(env, { ip: '198.51.100.5' });
  const e2 = uniqueEmail();
  await register(d, e2);
  for (let i = 0; i < 6; i++) { advance(10 * DAY); await d.get('/api/auth/me'); }   // usa sempre, mas passa de 60 dias
  assert.equal((await d.get('/api/auth/me')).status, 401, 'limite absoluto de 60 dias');
});

test('CSRF: só aceita pedidos que alteram dados vindos do próprio site', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  const { email } = await register(c);
  const evil = await c.post('/api/sync', { items: { upsert: [] } }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403); assert.equal(evil.json.error, 'forbidden_origin');
  assert.equal((await c.post('/api/sync', {}, { origin: null })).status, 403, 'sem Origin e sem Sec-Fetch-Site');
  assert.equal((await c.post('/api/sync', {}, { origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await c.post('/api/sync', {}, { origin: null, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await c.post('/api/auth/logout', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.post('/api/auth/change-password', { current: GOOD_PW, next: 'Outra-Senha-Forte-55' }, { origin: 'http://agenda.test' })).status, 403, 'esquema diferente');
  assert.equal((await c.get('/api/auth/me')).status, 200, 'o logout forjado não derrubou a sessão');
  assert.equal((await login(makeClient(env, { ip: '198.51.100.20' }), email, GOOD_PW)).status, 200);
});

test('corpo da requisição: tipo, tamanho e JSON inválido', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  await register(c);
  assert.equal((await c.req('POST', '/api/sync', undefined, { raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await c.req('POST', '/api/sync', undefined, { raw: '{nao-json' , headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await c.req('POST', '/api/sync', undefined, { raw: '[]', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await c.req('POST', '/api/sync', undefined, { raw: 'null', headers: { 'Content-Type': 'application/json' } })).status, 400);
  const big = JSON.stringify({ items: { upsert: [], pad: 'x'.repeat(600 * 1024) } });
  assert.equal((await c.req('POST', '/api/sync', undefined, { raw: big, headers: { 'Content-Type': 'application/json' } })).status, 413);
});

test('força bruta: atraso progressivo depois de 5 erros, sem bloquear outros aparelhos', async () => {
  const { env } = makeEnv();
  const owner = makeClient(env, { ip: '198.51.100.30' });
  const { email } = await register(owner);
  const atk = makeClient(env, { ip: '203.0.113.99' });
  for (let i = 0; i < 5; i++) assert.equal((await login(atk, email, 'Palpite-Errado-' + i + 'xx')).status, 401);
  assert.equal((await login(atk, email, 'Palpite-Errado-5xx')).status, 401);     // 6ª falha dispara o atraso
  const blocked = await login(atk, email, GOOD_PW);                               // até a senha certa espera
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) >= 1);
  // o dono, de outro aparelho/IP, não é afetado
  assert.equal((await login(makeClient(env, { ip: '198.51.100.31' }), email)).status, 200);
  // passado o atraso, volta a funcionar
  advance(16 * 1000);
  assert.equal((await login(atk, email, GOOD_PW)).status, 200);
});

test('força bruta distribuída: acima do limite da conta só entram aparelhos já conhecidos', async () => {
  const { env } = makeEnv();
  const owner = makeClient(env, { ip: '198.51.100.40' });
  const { email } = await register(owner);
  for (let i = 0; i < 45; i++) {
    const bot = makeClient(env, { ip: `203.0.113.${(i % 200) + 1}`.replace(/\.(\d+)$/, (_, n) => '.' + (Number(n) + 100)) });
    bot.ip = `192.0.2.${i + 1}`;
    await login(bot, email, 'Chute-Distribuido-' + i);
  }
  const stranger = makeClient(env, { ip: '192.0.2.250' });
  assert.equal((await login(stranger, email)).status, 429, 'IP desconhecido bloqueado enquanto a conta está sob ataque');
  assert.equal((await login(makeClient(env, { ip: '198.51.100.40' }), email)).status, 200, 'o dono (IP já conhecido) consegue entrar');
});

test('limite por IP no login', async () => {
  const { env } = makeEnv();
  const c = makeClient(env, { ip: '203.0.113.200' });
  let last;
  for (let i = 0; i < 61; i++) last = await login(c, `x${i}@example.com`, 'Qualquer-Senha-1234');
  assert.equal(last.status, 429);
});

test('limite de cadastros por IP', async () => {
  const { env } = makeEnv();
  const c = makeClient(env, { ip: '203.0.113.201' });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await register(c)).status);
  assert.deepEqual(codes.slice(0, 6), [201, 201, 201, 201, 201, 201]);
  assert.equal(codes[6], 429);
});

test('cadastro fechado por configuração', async () => {
  const { env } = makeEnv({ REGISTRATION_OPEN: 'false' });
  const r = await register(makeClient(env));
  assert.equal(r.status, 403); assert.equal(r.json.error, 'registration_closed');
  assert.equal((await makeClient(env).get('/api/config')).json.registrationOpen, false);
});

test('trocar senha: exige a atual, aplica política e derruba os outros aparelhos', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.50' });
  const { email } = await register(a);
  const b = makeClient(env, { ip: '198.51.100.51' });
  await login(b, email);
  assert.equal((await a.post('/api/auth/change-password', { current: 'Errada-Errada-123', next: 'Nova-Senha-Forte-77' })).status, 403);
  assert.equal((await a.post('/api/auth/change-password', { current: GOOD_PW, next: 'curta' })).json.error, 'password_too_short');
  assert.equal((await a.post('/api/auth/change-password', { current: GOOD_PW, next: 'Nova-Senha-Forte-77' })).status, 200);
  assert.equal((await a.get('/api/auth/me')).status, 200, 'aparelho atual continua');
  assert.equal((await b.get('/api/auth/me')).status, 401, 'outro aparelho foi desconectado');
  assert.equal((await login(makeClient(env, { ip: '198.51.100.52' }), email, GOOD_PW)).status, 401);
  assert.equal((await login(makeClient(env, { ip: '198.51.100.53' }), email, 'Nova-Senha-Forte-77')).status, 200);
});

test('trocar senha exige estar logado', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  assert.equal((await c.post('/api/auth/change-password', { current: 'x', next: 'y' })).status, 401);
});

test('recuperação com código: uso único, senha fraca não gasta o código, derruba sessões', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.60' });
  const reg = await register(a);
  const [c1, c2] = reg.json.recoveryCodes;
  const anon = makeClient(env, { ip: '198.51.100.61' });
  assert.equal((await anon.post('/api/auth/recover', { email: reg.email, code: c1, newPassword: 'curta' })).json.error, 'password_too_short');
  assert.equal((await anon.post('/api/auth/recover', { email: reg.email, code: 'AAAA-BBBB-CCCC', newPassword: 'Nova-Senha-Forte-88' })).json.error, 'invalid_recovery');
  assert.equal((await anon.post('/api/auth/recover', { email: 'ninguem@example.com', code: c1, newPassword: 'Nova-Senha-Forte-88' })).json.error, 'invalid_recovery');
  const ok = await anon.post('/api/auth/recover', { email: reg.email, code: c1.toLowerCase().replace(/-/g, ' '), newPassword: 'Nova-Senha-Forte-88' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.codesLeft, 7);
  assert.equal((await anon.post('/api/auth/recover', { email: reg.email, code: c1, newPassword: 'Outra-Senha-Forte-99' })).json.error, 'invalid_recovery', 'código só vale uma vez');
  assert.equal((await a.get('/api/auth/me')).status, 401, 'sessões antigas encerradas');
  assert.equal((await login(anon, reg.email, 'Nova-Senha-Forte-88')).status, 200);
  assert.equal((await anon.post('/api/auth/recover', { email: reg.email, code: c2, newPassword: 'Mais-Uma-Senha-Forte-1' })).status, 200);
});

test('recuperação: limite de tentativas contra adivinhação de código', async () => {
  const { env } = makeEnv();
  const reg = await register(makeClient(env, { ip: '198.51.100.70' }));
  const atk = makeClient(env, { ip: '203.0.113.150' });
  let last;
  for (let i = 0; i < 12; i++) last = await atk.post('/api/auth/recover', { email: reg.email, code: 'AAAA-BBBB-C' + String(i).padStart(3, 'D'), newPassword: 'Nova-Senha-Forte-88' });
  assert.equal(last.status, 429);
});

test('redefinição por e-mail: link de uso único, expira em 30 min, resposta igual para conta inexistente', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  const { env } = makeEnv({ RESEND_API_KEY: 're_test_key', MAIL_FROM: 'Agenda <nao-responda@example.com>' });
  const deps = { fetchImpl };
  const a = makeClient(env, { ip: '198.51.100.80', deps });
  const reg = await register(a);
  const anon = makeClient(env, { ip: '198.51.100.81', deps });
  const ghost = await anon.post('/api/auth/forgot', { email: 'ninguem@example.com' });
  const real = await anon.post('/api/auth/forgot', { email: reg.email });
  assert.deepEqual(ghost.json, real.json); assert.equal(ghost.status, real.status);
  assert.equal(sent.length, 1, 'só a conta real recebe e-mail');
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(sent[0].body.to, [reg.email]);
  const link = /(https:\/\/agenda\.test\/#reset=[\w-]+)/.exec(sent[0].body.text)[1];
  assert.ok(link.includes('#reset='), 'token vai no fragmento (não é enviado ao servidor em navegações)');
  const token = link.split('#reset=')[1];
  assert.equal((await anon.post('/api/auth/reset', { token: 'x'.repeat(43), newPassword: 'Nova-Senha-Forte-12' })).json.error, 'invalid_reset');
  assert.equal((await anon.post('/api/auth/reset', { token, newPassword: 'curta' })).json.error, 'password_too_short');
  assert.equal((await anon.post('/api/auth/reset', { token, newPassword: 'Nova-Senha-Forte-12' })).status, 200);
  assert.equal((await anon.post('/api/auth/reset', { token, newPassword: 'Outra-Senha-Forte-13' })).json.error, 'invalid_reset', 'link só funciona uma vez');
  assert.equal((await a.get('/api/auth/me')).status, 401);
  // expiração
  const anon2 = makeClient(env, { ip: '198.51.100.82', deps });
  await anon2.post('/api/auth/forgot', { email: reg.email });
  const t2 = /#reset=([\w-]+)/.exec(sent[1].body.text)[1];
  advance(31 * MIN);
  assert.equal((await anon2.post('/api/auth/reset', { token: t2, newPassword: 'Nova-Senha-Forte-14' })).json.error, 'invalid_reset');
});

test('redefinição por e-mail desligada quando não há provedor configurado', async () => {
  const { env } = makeEnv();
  const c = makeClient(env, { ip: '198.51.100.90' });
  const reg = await register(c);
  const r = await c.post('/api/auth/forgot', { email: reg.email });
  assert.equal(r.status, 200);
  assert.equal((await c.get('/api/config')).json.mailReset, false);
});

test('verificação em duas etapas (TOTP): ativar, exigir no login, bloquear reuso do código', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.100' });
  const reg = await register(a);
  assert.equal((await a.post('/api/auth/totp/setup', { password: 'errada' })).status, 403);
  const setup = await a.post('/api/auth/totp/setup', { password: GOOD_PW });
  assert.equal(setup.status, 200);
  assert.match(setup.json.uri, /^otpauth:\/\/totp\//);
  const secret = base32Decode(setup.json.secret);
  const code = async (offset = 0) => hotp(secret, Math.floor(clock.t / 30000) + offset);
  assert.equal((await a.post('/api/auth/totp/enable', { code: '000000' })).status, 400);
  assert.equal((await a.post('/api/auth/totp/enable', { code: await code() })).status, 200);
  // login passa a exigir o código
  const b = makeClient(env, { ip: '198.51.100.101' });
  const step1 = await login(b, reg.email);
  assert.equal(step1.status, 401); assert.equal(step1.json.error, 'mfa_required');
  assert.equal(b.jar.size, 0);
  assert.equal((await login(b, reg.email, GOOD_PW, { code: '123456' })).status, 401);
  advance(30 * 1000);
  const good = await code();
  assert.equal((await login(b, reg.email, GOOD_PW, { code: good })).status, 200);
  const c = makeClient(env, { ip: '198.51.100.102' });
  assert.equal((await login(c, reg.email, GOOD_PW, { code: good })).status, 401, 'mesmo código não vale duas vezes');
  // MFA com senha errada não revela que existe MFA
  const d = makeClient(env, { ip: '198.51.100.103' });
  assert.equal((await login(d, reg.email, 'Senha-Errada-1234')).json.error, 'invalid_credentials');
  // desativar exige senha e código
  advance(30 * 1000);
  assert.equal((await b.post('/api/auth/totp/disable', { password: GOOD_PW })).status, 403);
  assert.equal((await b.post('/api/auth/totp/disable', { password: GOOD_PW, code: await code() })).status, 200);
  assert.equal((await login(makeClient(env, { ip: '198.51.100.104' }), reg.email)).status, 200);
});

test('com TOTP ativo, o código de recuperação sozinho não redefine a senha', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.110' });
  const reg = await register(a);
  const setup = await a.post('/api/auth/totp/setup', { password: GOOD_PW });
  const secret = base32Decode(setup.json.secret);
  await a.post('/api/auth/totp/enable', { code: await hotp(secret, Math.floor(clock.t / 30000)) });
  const anon = makeClient(env, { ip: '198.51.100.111' });
  const r = await anon.post('/api/auth/recover', { email: reg.email, code: reg.json.recoveryCodes[0], newPassword: 'Nova-Senha-Forte-31' });
  assert.equal(r.status, 400);
  advance(30 * 1000);
  const ok = await anon.post('/api/auth/recover', { email: reg.email, code: reg.json.recoveryCodes[0], newPassword: 'Nova-Senha-Forte-31', totp: await hotp(secret, Math.floor(clock.t / 30000)) });
  assert.equal(ok.status, 200, ok.text);
});

test('sessões: lista só as da própria conta e permite encerrar as outras', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.120' });
  const reg = await register(a);
  const b = makeClient(env, { ip: '198.51.100.121', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
  await login(b, reg.email);
  const other = makeClient(env, { ip: '198.51.100.122' });
  await register(other);
  const list = (await a.get('/api/auth/sessions')).json.sessions;
  assert.equal(list.length, 2);
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.ok(list.some((s) => s.ua === 'Safari · iPhone/iPad'));
  assert.ok(!JSON.stringify(list).includes('198.51.100'), 'IP não é exposto');
  assert.equal((await a.post('/api/auth/sessions/revoke-others')).status, 200);
  assert.equal((await b.get('/api/auth/me')).status, 401);
  assert.equal((await a.get('/api/auth/me')).status, 200);
  assert.equal((await other.get('/api/auth/me')).status, 200, 'outra conta não foi afetada');
});

test('códigos de recuperação novos exigem senha e invalidam os antigos', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.130' });
  const reg = await register(a);
  assert.equal((await a.post('/api/auth/recovery-codes', { password: 'errada' })).status, 403);
  const r = await a.post('/api/auth/recovery-codes', { password: GOOD_PW });
  assert.equal(r.json.recoveryCodes.length, 8);
  const anon = makeClient(env, { ip: '198.51.100.131' });
  assert.equal((await anon.post('/api/auth/recover', { email: reg.email, code: reg.json.recoveryCodes[0], newPassword: 'Nova-Senha-Forte-41' })).json.error, 'invalid_recovery');
  assert.equal((await anon.post('/api/auth/recover', { email: reg.email, code: r.json.recoveryCodes[0], newPassword: 'Nova-Senha-Forte-41' })).status, 200);
});

test('excluir conta: exige senha e confirmação, apaga tudo e encerra a sessão', async () => {
  const { env, db } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.140' });
  const reg = await register(a);
  await a.post('/api/sync', { items: { upsert: [{ id: 'a1', titulo: 'Prova', materia: 'Mat', tipo: 'prova', data: '2026-10-20' }] } });
  assert.equal((await a.post('/api/account/delete', { password: GOOD_PW })).json.error, 'confirmation_required');
  assert.equal((await a.post('/api/account/delete', { password: 'errada-errada-1', confirm: 'EXCLUIR' })).status, 403);
  assert.equal((await a.get('/api/auth/me')).status, 200, 'nada foi apagado ainda');
  const del = await a.post('/api/account/delete', { password: GOOD_PW, confirm: 'EXCLUIR' });
  assert.equal(del.status, 200);
  assert.equal(a.jar.size, 0);
  assert.equal((await login(makeClient(env, { ip: '198.51.100.141' }), reg.email)).status, 401);
  for (const t of ['users', 'items', 'materias', 'sessions', 'push_subs', 'recovery_codes', 'reset_tokens']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t + ' deveria estar vazia');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit WHERE user_id IS NOT NULL').get().n, 0, 'auditoria desvinculada da conta');
});

test('exportar dados: devolve só os dados da própria conta, sem hashes', async () => {
  const { env } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.150' });
  const ra = await register(a);
  const b = makeClient(env, { ip: '198.51.100.151' });
  const rb = await register(b);
  await a.post('/api/sync', { items: { upsert: [{ id: 'a1', titulo: 'Só da Ana', materia: 'Mat', tipo: 'tarefa', data: '2026-10-20' }] } });
  await b.post('/api/sync', { items: { upsert: [{ id: 'b1', titulo: 'Só do Beto', materia: 'Mat', tipo: 'tarefa', data: '2026-10-20' }] } });
  const ex = await a.get('/api/account/export');
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('Content-Disposition'), /attachment/);
  assert.ok(ex.text.includes('Só da Ana') && ex.text.includes(ra.email));
  assert.ok(!ex.text.includes('Só do Beto') && !ex.text.includes(rb.email));
  assert.ok(!/pw_hash|pbkdf2|totp_secret|code_hash/.test(ex.text));
});

test('auditoria não guarda senhas, e-mails nem IPs em claro', async () => {
  const { env, db } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.160' });
  const reg = await register(a);
  await login(makeClient(env, { ip: '198.51.100.161' }), reg.email, 'Senha-Errada-1234');
  await login(makeClient(env, { ip: '198.51.100.162' }), 'fantasma@example.com', 'Senha-Errada-1234');
  const rows = JSON.stringify(db.prepare('SELECT * FROM audit').all());
  assert.ok(rows.includes('login_fail') && rows.includes('register'));
  for (const bad of [reg.email, 'fantasma', 'Senha-Errada', GOOD_PW, '198.51.100']) assert.ok(!rows.includes(bad), bad);
});
