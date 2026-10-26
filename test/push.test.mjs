import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClient, register, clock } from './helpers.mjs';
import { runScheduled } from '../src/app.js';
import { b64uEncode, b64uDecode, utf8, fromUtf8 } from '../src/util.js';

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);          // 18/10/2026 12:00 UTC = 09:00 em São Paulo (domingo)
const DAY = 864e5;

/** Um "navegador": gera as chaves reais de uma inscrição push e sabe decifrar a mensagem (RFC 8291). */
async function browserSub(host = 'fcm.googleapis.com') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `https://${host}/fcm/send/${b64uEncode(crypto.getRandomValues(new Uint8Array(24)))}`;
  const decrypt = async (body) => {
    const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, kp.privateKey, 256));
    const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
    const ikm = await hk(auth, secret, new Uint8Array([...utf8('WebPush: info\0'), ...pub, ...asPub]), 32);
    const cek = await hk(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hk(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
    return JSON.parse(fromUtf8(plain.slice(0, -1)));
  };
  return { subscription: { endpoint, keys: { p256dh: b64uEncode(pub), auth: b64uEncode(auth) } }, endpoint, decrypt };
}

async function vapidEnv() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    VAPID_PUBLIC: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    VAPID_PRIVATE: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d,
    VAPID_SUBJECT: 'mailto:contato@example.com',
  };
}

const mockPush = (status = 201) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: typeof status === 'function' ? status(url) : status }); } }; };
const item = (id, o = {}) => ({ id, titulo: 'T ' + id, materia: 'Matemática', tipo: 'tarefa', data: '2026-10-19', ...o });
let ipn = 0;
const newUser = async (env, deps) => { const c = makeClient(env, { ip: `198.51.100.${++ipn}`, deps }); await register(c); return c; };
const ONE_DAY_OUT = { items: { upsert: [item('p1', { tipo: 'prova', materia: 'Matemática', data: '2026-10-19' })] } };

test('inscrição: exige sessão e aceita um aparelho válido', async () => {
  clock.t = T0;
  const { env, db } = makeEnv();
  const anon = makeClient(env);
  const b = await browserSub();
  assert.equal((await anon.post('/api/push/subscribe', { subscription: b.subscription })).status, 401);
  assert.equal((await anon.post('/api/push/unsubscribe', { endpoint: b.endpoint })).status, 401);
  assert.equal((await anon.req('PUT', '/api/push/prefs', { hour: 8 })).status, 401);
  assert.equal((await anon.post('/api/push/test', {})).status, 401);
  const c = await newUser(env);
  const r = await c.post('/api/push/subscribe', { subscription: b.subscription, tz: 'America/Sao_Paulo', hour: 8 });
  assert.equal(r.status, 200);
  const u = db.prepare('SELECT notif_enabled, notif_hour, tz FROM users').get();
  assert.deepEqual({ ...u }, { notif_enabled: 1, notif_hour: 8, tz: 'America/Sao_Paulo' });
});

test('SSRF: o servidor só aceita endereços https dos serviços de push conhecidos', async () => {
  clock.t = T0;
  const { env, db } = makeEnv();
  const c = await newUser(env);
  const good = await browserSub();
  const evil = [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://evil.example/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com/x',
    'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://10.0.0.5/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'ftp://fcm.googleapis.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'nao-e-url', '',
    'https://fcm.googleapis.com/' + 'a'.repeat(600),
  ];
  for (const endpoint of evil) {
    const r = await c.post('/api/push/subscribe', { subscription: { endpoint, keys: good.subscription.keys } });
    assert.equal(r.status, 400, endpoint.slice(0, 60));
  }
  for (const host of ['push.services.mozilla.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com']) {
    const b = await browserSub(host);
    assert.equal((await c.post('/api/push/subscribe', { subscription: b.subscription })).status, 200, host);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 4, 'nenhum endereço perigoso foi gravado');
});

test('inscrição: chaves inválidas, fuso inválido e hora inválida são recusados', async () => {
  clock.t = T0;
  const { env } = makeEnv();
  const c = await newUser(env);
  const b = await browserSub();
  const sub = (keys) => ({ subscription: { endpoint: b.endpoint, keys } });
  assert.equal((await c.post('/api/push/subscribe', sub({ p256dh: 'AAAA', auth: b.subscription.keys.auth }))).status, 400);
  assert.equal((await c.post('/api/push/subscribe', sub({ p256dh: b.subscription.keys.p256dh, auth: '<script>' }))).status, 400);
  assert.equal((await c.post('/api/push/subscribe', sub({}))).status, 400);
  assert.equal((await c.post('/api/push/subscribe', {})).status, 400);
  assert.equal((await c.post('/api/push/subscribe', { subscription: b.subscription, tz: 'Marte/Phobos' })).status, 400);
  assert.equal((await c.post('/api/push/subscribe', { subscription: b.subscription, hour: 24 })).status, 400);
  assert.equal((await c.post('/api/push/subscribe', { subscription: b.subscription, hour: '8' })).status, 400);
  assert.equal((await c.req('PUT', '/api/push/prefs', { hour: -1 })).status, 400);
  assert.equal((await c.req('PUT', '/api/push/prefs', { enabled: 'sim' })).status, 400);
  assert.equal((await c.req('PUT', '/api/push/prefs', { tz: 'x'.repeat(100) })).status, 400);
  assert.equal((await c.req('PUT', '/api/push/prefs', { hour: 7, tz: 'America/Sao_Paulo' })).status, 200);
});

test('limite de 10 aparelhos por conta (o 11º é recusado)', async () => {
  clock.t = T0;
  const { env, db } = makeEnv();
  const c = await newUser(env);
  for (let i = 0; i < 10; i++) assert.equal((await c.post('/api/push/subscribe', { subscription: (await browserSub()).subscription })).status, 200);
  assert.equal((await c.post('/api/push/subscribe', { subscription: (await browserSub()).subscription })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 10);
});

test('cancelar: só remove inscrições da própria conta; sem aparelhos o aviso é desligado', async () => {
  clock.t = T0;
  const { env, db } = makeEnv();
  const a = await newUser(env), b = await newUser(env);
  const sa = await browserSub();
  await a.post('/api/push/subscribe', { subscription: sa.subscription, hour: 8, tz: 'America/Sao_Paulo' });
  await b.post('/api/push/unsubscribe', { endpoint: sa.endpoint });                 // outra conta tenta remover
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 1);
  assert.equal((await a.post('/api/push/unsubscribe', { endpoint: 42 })).status, 400);
  await a.post('/api/push/unsubscribe', { endpoint: sa.endpoint });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0);
  assert.equal(db.prepare('SELECT notif_enabled AS e FROM users ORDER BY rowid LIMIT 1').get().e, 0, 'sem aparelhos, o aviso fica desligado');
});

test('aviso de teste: sem chaves VAPID responde 503; com chaves envia mensagem cifrada e assinada', async () => {
  clock.t = T0;
  const sem = makeEnv();
  const c0 = await newUser(sem.env);
  await c0.post('/api/push/subscribe', { subscription: (await browserSub()).subscription });
  assert.equal((await c0.post('/api/push/test', {})).json.error, 'push_not_configured');

  const vapid = await vapidEnv();
  const { env } = makeEnv(vapid);
  const m = mockPush(201);
  const c = await newUser(env, { fetchImpl: m.fetchImpl, now: () => T0 });
  const b = await browserSub();
  await c.post('/api/push/subscribe', { subscription: b.subscription });
  const r = await c.post('/api/push/test', {});
  assert.deepEqual(r.json, { sent: 1, devices: 1 });
  assert.equal(m.calls.length, 1);
  const { url, init } = m.calls[0];
  assert.equal(url, b.endpoint);
  assert.match(init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.redirect, 'manual', 'nunca seguir redirecionamento');
  assert.equal(JSON.stringify(init).includes('senha'), false);
  const msg = await b.decrypt(init.body);
  assert.match(msg.body, /funcionando/);
  // limite: 5 testes por hora
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/push/test', {})).status, 200);
  assert.equal((await c.post('/api/push/test', {})).status, 429);
});

test('aviso de teste: serviço responde 410 -> inscrição morta é removida', async () => {
  clock.t = T0;
  const { env, db } = makeEnv(await vapidEnv());
  const c = await newUser(env, { fetchImpl: mockPush(410).fetchImpl, now: () => T0 });
  await c.post('/api/push/subscribe', { subscription: (await browserSub()).subscription });
  const r = await c.post('/api/push/test', {});
  assert.deepEqual(r.json, { sent: 0, devices: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0);
});

test('agendamento diário: envia na hora escolhida, uma vez por dia, com o texto certo', async () => {
  clock.t = T0;
  const { env, db } = makeEnv(await vapidEnv());
  const c = await newUser(env);
  const b = await browserSub();
  await c.post('/api/sync', ONE_DAY_OUT);
  await c.post('/api/push/subscribe', { subscription: b.subscription, tz: 'America/Sao_Paulo', hour: 10 });
  const m = mockPush(201);
  const run = (t) => runScheduled(env, { now: () => t, fetchImpl: m.fetchImpl });

  // 09:00 em São Paulo: ainda não é a hora escolhida (10h)
  assert.deepEqual(await run(T0), { users: 0, sent: 0, failed: 0 });
  assert.equal(m.calls.length, 0);
  // 10:00: envia
  const r = await run(T0 + 3600e3);
  assert.deepEqual(r, { users: 1, sent: 1, failed: 0 });
  const msg = await b.decrypt(m.calls[0].init.body);
  assert.match(msg.title, /Amanhã: prova de Matemática/);
  assert.match(msg.body, /dia 19\/10 \(seg\) é prova de Matemática/i);
  assert.equal(msg.tag, 'digest-2026-10-18');
  // 11:00 do mesmo dia: não repete
  await run(T0 + 2 * 3600e3);
  assert.equal(m.calls.length, 1);
  // dia seguinte, 10:00: envia de novo (a prova agora é hoje)
  await run(T0 + DAY + 3600e3);
  assert.equal(m.calls.length, 2);
  assert.match((await b.decrypt(m.calls[1].init.body)).title, /Hoje: prova de Matemática/);
  assert.equal(db.prepare('SELECT last_digest_day AS d FROM users').get().d, '2026-10-19');
});

test('agendamento: respeita o fuso de cada pessoa', async () => {
  clock.t = T0;
  const { env, db } = makeEnv(await vapidEnv());
  const c = await newUser(env);
  const b = await browserSub();
  await c.post('/api/sync', { items: { upsert: [item('q1', { tipo: 'teste', data: '2026-10-19' })] } });
  await c.post('/api/push/subscribe', { subscription: b.subscription, tz: 'Asia/Tokyo', hour: 20 });
  const m = mockPush(201);
  // 12:00 UTC = 21:00 em Tóquio (já passou das 20h) -> envia, e o "hoje" é o dia de Tóquio
  const r = await runScheduled(env, { now: () => T0, fetchImpl: m.fetchImpl });
  assert.equal(r.sent, 1);
  assert.equal((await b.decrypt(m.calls[0].init.body)).tag, 'digest-2026-10-18');
  // 03:00 UTC de 18/10 = meia-noite em São Paulo: a hora é 0 (nunca "24") e o dia já é 18/10
  const c2 = await newUser(env); const b2 = await browserSub();
  await c2.post('/api/push/subscribe', { subscription: b2.subscription, tz: 'America/Sao_Paulo', hour: 0 });
  const r2 = await runScheduled(env, { now: () => Date.UTC(2026, 9, 18, 3, 0, 0), fetchImpl: m.fetchImpl });
  assert.deepEqual(r2, { users: 1, sent: 0, failed: 0 }, 'à meia-noite (hora 0) a pessoa entra no lote; sem atividades não há mensagem');
  assert.equal(db.prepare('SELECT last_digest_day AS d FROM users ORDER BY rowid DESC LIMIT 1').get().d, '2026-10-18');
});

test('agendamento: nada relevante = nenhuma notificação (sem spam)', async () => {
  clock.t = T0;
  const { env, db } = makeEnv(await vapidEnv());
  const c = await newUser(env);
  await c.post('/api/push/subscribe', { subscription: (await browserSub()).subscription, tz: 'America/Sao_Paulo', hour: 8 });
  await c.post('/api/sync', { items: { upsert: [item('f1', { data: '2026-12-30' }), item('f2', { data: '2026-10-19', feita: true })] } });
  const m = mockPush(201);
  const r = await runScheduled(env, { now: () => T0, fetchImpl: m.fetchImpl });
  assert.equal(m.calls.length, 0);
  assert.equal(r.sent, 0);
  assert.equal(db.prepare('SELECT last_digest_day AS d FROM users').get().d, '2026-10-18', 'marcado para não reprocessar o dia todo');
});

test('agendamento: cada pessoa só recebe as próprias atividades (isolamento)', async () => {
  clock.t = T0;
  const { env } = makeEnv(await vapidEnv());
  const a = await newUser(env), b = await newUser(env);
  const sa = await browserSub(), sb = await browserSub('push.services.mozilla.com');
  await a.post('/api/sync', { items: { upsert: [item('a1', { tipo: 'prova', materia: 'Segredo-da-Ana', data: '2026-10-19' })] } });
  await b.post('/api/sync', { items: { upsert: [item('b1', { tipo: 'seminario', materia: 'Segredo-do-Beto', data: '2026-10-20' })] } });
  await a.post('/api/push/subscribe', { subscription: sa.subscription, tz: 'America/Sao_Paulo', hour: 8 });
  await b.post('/api/push/subscribe', { subscription: sb.subscription, tz: 'America/Sao_Paulo', hour: 8 });
  const m = mockPush(201);
  await runScheduled(env, { now: () => T0, fetchImpl: m.fetchImpl });
  assert.equal(m.calls.length, 2);
  for (const call of m.calls) {
    const own = call.url === sa.endpoint ? sa : sb;
    const text = JSON.stringify(await own.decrypt(call.init.body));
    assert.ok(text.includes(own === sa ? 'Segredo-da-Ana' : 'Segredo-do-Beto'));
    assert.ok(!text.includes(own === sa ? 'Segredo-do-Beto' : 'Segredo-da-Ana'));
  }
});

test('agendamento: falhas repetem no mesmo dia; 410 remove; 5 falhas removem o aparelho', async () => {
  clock.t = T0;
  const { env, db } = makeEnv(await vapidEnv());
  const c = await newUser(env);
  await c.post('/api/sync', ONE_DAY_OUT);
  const b = await browserSub();
  await c.post('/api/push/subscribe', { subscription: b.subscription, tz: 'America/Sao_Paulo', hour: 8 });
  const falha = mockPush(500);
  for (let i = 1; i <= 4; i++) {
    const r = await runScheduled(env, { now: () => T0, fetchImpl: falha.fetchImpl });
    assert.equal(r.failed, 1);
    assert.equal(db.prepare('SELECT fail_count AS n FROM push_subs').get().n, i);
    assert.equal(db.prepare('SELECT last_digest_day AS d FROM users').get().d, null, 'não marca como enviado se falhou');
  }
  await runScheduled(env, { now: () => T0, fetchImpl: falha.fetchImpl });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0, 'após 5 falhas o aparelho é removido');

  const c2 = await newUser(env);
  await c2.post('/api/sync', ONE_DAY_OUT);
  await c2.post('/api/push/subscribe', { subscription: (await browserSub()).subscription, tz: 'America/Sao_Paulo', hour: 8 });
  await runScheduled(env, { now: () => T0, fetchImpl: mockPush(410).fetchImpl });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0, '410 remove na hora');

  const c3 = await newUser(env);
  await c3.post('/api/sync', ONE_DAY_OUT);
  await c3.post('/api/push/subscribe', { subscription: (await browserSub()).subscription, tz: 'America/Sao_Paulo', hour: 8 });
  const boom = { fetchImpl: async () => { throw new Error('rede caiu'); } };
  const r = await runScheduled(env, { now: () => T0, ...boom });
  assert.equal(r.failed, 1, 'exceção de rede conta como falha e não derruba a rotina');
});

test('agendamento: sem VAPID não envia; MAX_PUSH_PER_RUN limita o lote', async () => {
  clock.t = T0;
  const sem = makeEnv();
  assert.deepEqual(await runScheduled(sem.env, { now: () => T0 }), { skipped: 'no_vapid' });
  assert.deepEqual(await runScheduled({}, {}), { skipped: 'no_db' });

  const { env } = makeEnv({ ...(await vapidEnv()), MAX_PUSH_PER_RUN: '1' });
  for (let i = 0; i < 2; i++) {
    const c = await newUser(env);
    await c.post('/api/sync', ONE_DAY_OUT);
    await c.post('/api/push/subscribe', { subscription: (await browserSub()).subscription, tz: 'America/Sao_Paulo', hour: 8 });
  }
  const m = mockPush(201);
  assert.equal((await runScheduled(env, { now: () => T0, fetchImpl: m.fetchImpl })).sent, 1);
  assert.equal((await runScheduled(env, { now: () => T0, fetchImpl: m.fetchImpl })).sent, 1, 'o segundo usuário sai na rodada seguinte');
  assert.equal((await runScheduled(env, { now: () => T0, fetchImpl: m.fetchImpl })).sent, 0);
});

test('o mesmo aparelho trocando de conta passa a pertencer à conta atual', async () => {
  clock.t = T0;
  const { env, db } = makeEnv();
  const a = await newUser(env), b = await newUser(env);
  const s = await browserSub();
  await a.post('/api/push/subscribe', { subscription: s.subscription });
  await b.post('/api/push/subscribe', { subscription: s.subscription });
  const rows = db.prepare('SELECT user_id FROM push_subs').all();
  assert.equal(rows.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs ps JOIN users u ON u.id = ps.user_id').get().n, 1);
});
