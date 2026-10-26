// Testes escritos a partir da revisão de segurança independente (achados A1, M2, M3, B2, B4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClient, register, GOOD_PW, clock } from './helpers.mjs';
import { ipKey } from '../src/app.js';

test('A1: 200 tentativas simultâneas de IPs diferentes não passam do teto de 40 por conta', async () => {
  const { env } = makeEnv();
  const dono = makeClient(env, { ip: '198.51.100.1' });
  const { email } = await register(dono);
  const tentativas = await Promise.all(Array.from({ length: 200 }, (_, i) => makeClient(env, { ip: `203.0.${Math.floor(i / 250)}.${i + 1}` }).post('/api/auth/login', { email, password: 'Palpite-Errado-' + i })));
  const naoBloqueadas = tentativas.filter((r) => r.status === 401).length;
  assert.ok(naoBloqueadas <= 41, `passaram ${naoBloqueadas} tentativas`);
  assert.ok(tentativas.filter((r) => r.status === 429).length >= 150);
});

test('A1: login certo devolve a reserva (o dono não se bloqueia entrando várias vezes)', async () => {
  const { env } = makeEnv();
  const c = makeClient(env, { ip: '198.51.100.2' });
  const { email } = await register(c);
  for (let i = 0; i < 50; i++) assert.equal((await makeClient(env, { ip: '198.51.100.2' }).post('/api/auth/login', { email, password: GOOD_PW })).status, 200);
});

test('M3: IPv6 do mesmo bloco /64 divide o mesmo limite', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('2001:db8:abcd:12::1'), '2001:db8:abcd:12');
  assert.equal(ipKey('2001:db8:abcd:12:ffff:ffff:ffff:ffff'), '2001:db8:abcd:12');
  assert.equal(ipKey('2001:DB8:abcd:0012::1'), ipKey('2001:db8:abcd:12:9:9:9:9'));
  assert.equal(ipKey('::1'), '0:0:0:0');
  assert.notEqual(ipKey('2001:db8:abcd:13::1'), ipKey('2001:db8:abcd:12::1'));
});

test('M2: pedidos de cadastro inválidos não gastam o teto global diário', async () => {
  const { env, db } = makeEnv();
  for (let i = 0; i < 30; i++) await makeClient(env, { ip: `192.0.2.${i + 1}` }).post('/api/auth/register', {});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'reg:all'").get().n, 0);
  assert.equal((await register(makeClient(env, { ip: '192.0.2.200' }))).status, 201);
});

test('B2: tipo enviado como lista é recusado com 400 (não 500)', async () => {
  const { env } = makeEnv();
  const c = makeClient(env, { ip: '198.51.100.3' }); await register(c);
  const r = await c.post('/api/sync', { items: { upsert: [{ id: 'x1', titulo: 't', materia: 'm', tipo: ['prova'], data: '2026-10-20' }] } });
  assert.equal(r.status, 400);
});

test('B4: link de redefinição usa PUBLIC_ORIGIN quando configurado', async () => {
  const sent = [];
  const { env } = makeEnv({ RESEND_API_KEY: 're_teste', MAIL_FROM: 'Agenda <nao-responda@example.com>', PUBLIC_ORIGIN: 'https://agenda.exemplo.com' });
  const c = makeClient(env, { ip: '198.51.100.4', deps: { fetchImpl: async (u, init) => { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); } } });
  const { email } = await register(c);
  await c.post('/api/auth/forgot', { email });
  assert.ok(sent.length === 1 && sent[0].html?.includes('https://agenda.exemplo.com/#reset=') || JSON.stringify(sent[0]).includes('https://agenda.exemplo.com/#reset='), JSON.stringify(sent));
});
