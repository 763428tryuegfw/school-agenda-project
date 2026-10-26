import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClient, register } from './helpers.mjs';

test('cadastro, sessão e /me funcionam', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  const r = await register(c);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.recoveryCodes.length, 8);
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, r.email);
});

test('endereço que não existe: página 404 própria com status HTTP 404, sem indexar, com cabeçalhos de segurança', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  for (const p of ['/nao-existe', '/privacidade', '/pasta/arquivo.png']) {
    const r = await c.get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.text, /Página não encontrada/); assert.match(r.text, /noindex/); assert.match(r.text, /href="\/"/);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  const api = await c.get('/api/nao-existe');
  assert.equal(api.status, 404); assert.equal(api.json.error, 'not_found');
  assert.equal((await c.get('/')).status, 200);
});

test('robots.txt e sitemap.xml usam o endereço real, escondem /api/ e só listam páginas públicas', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  const rb = await c.get('/robots.txt');
  assert.equal(rb.status, 200); assert.match(rb.headers.get('content-type'), /text\/plain/);
  assert.match(rb.text, /Disallow: \/api\//); assert.match(rb.text, /Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
  const sm = await c.get('/sitemap.xml');
  assert.equal(sm.status, 200); assert.match(sm.headers.get('content-type'), /xml/);
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  assert.deepEqual(locs.sort(), ['/', '/cookies.html', '/privacidade.html', '/termos.html']);
  assert.doesNotMatch(sm.text, /\/api\//);
  assert.equal((await c.req('POST', '/robots.txt', {})).status, 405);
});
