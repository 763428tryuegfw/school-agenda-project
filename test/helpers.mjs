// Ambiente de teste: simula o Durable Object (SQLite do Node), os arquivos estáticos e o navegador (cookies).
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { handle } from '../src/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGIN = 'https://agenda.test';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

export function makeSql(file = ':memory:') {
  const db = new DatabaseSync(file);
  let depth = 0;
  const sql = {
    exec(q, ...p) {
      p = p.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      const st = db.prepare(q);
      if (st.columns().length > 0) { const rows = st.all(...p).map((r) => ({ ...r })); return { toArray: () => rows }; }
      st.run(...p);
      return { toArray: () => [] };
    },
  };
  const tx = (fn) => {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE'); depth++;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { depth--; }
  };
  return { sql, tx, db };
}

export const clock = { t: Date.UTC(2026, 9, 18, 12, 0, 0) };   // 18/10/2026 12:00 UTC
export const advance = (ms) => { clock.t += ms; };

export function makeEnv(extra = {}, file = ':memory:') {
  const { sql, tx, db } = makeSql(file);
  const store = new Store(sql, tx);
  store.migrate();
  // Simula o RPC do Durable Object: chamada assíncrona e argumentos/retornos copiados (structured clone)
  const stub = new Proxy({}, {
    get: (_, name) => async (...args) => structuredClone(store[name](...structuredClone(args))),
  });
  const env = {
    DB: { idFromName: () => 'main', get: () => stub },
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        let p = u.pathname === '/' ? '/index.html' : u.pathname;
        if (p.includes('..')) return new Response('no', { status: 400 });
        try {
          const buf = await readFile(join(ROOT, 'public', p));
          return new Response(buf, { headers: { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' } });
        } catch {
          // Igual ao Cloudflare com "not_found_handling": "404-page": devolve a página 404.html com status 404.
          try { return new Response(await readFile(join(ROOT, 'public', '404.html')), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
          catch { return new Response('Not found', { status: 404 }); }
        }
      },
    },
    PEPPER: 'pepper-de-teste-pepper-de-teste-pepper-de-teste-0123456789',
    ...extra,
  };
  return { env, store, db };
}

export function makeClient(env, { ip = '203.0.113.7', ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', deps = {} } = {}) {
  const jar = new Map();
  const c = {
    ip, jar,
    async req(method, path, body, { headers = {}, origin = ORIGIN, raw, cookie } = {}) {
      const h = { 'CF-Connecting-IP': c.ip, 'User-Agent': ua, ...headers };
      if (origin) h.Origin = origin;
      const ck = cookie !== undefined ? cookie : [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) h.Cookie = ck;
      let payload;
      if (raw !== undefined) payload = raw;
      else if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; payload = JSON.stringify(body); }
      const res = await handle(new Request(ORIGIN + path, { method, headers: h, body: payload }), env, { now: () => clock.t, ...deps });
      for (const sc of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
        const i = pair.indexOf('=');
        const name = pair.slice(0, i), val = pair.slice(i + 1);
        if (attrs.some((a) => /^max-age=0$/i.test(a)) || val === '') jar.delete(name); else jar.set(name, val);
        res.cookies = (res.cookies || []).concat(sc);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      let data = null;
      try { data = JSON.parse(text); } catch { /* não é JSON */ }
      return { status: res.status, json: data, text, bytes, headers: res.headers, cookies: res.cookies || [] };
    },
    get: (p, o) => c.req('GET', p, undefined, o),
    post: (p, b, o) => c.req('POST', p, b ?? {}, o),
    put: (p, b, o) => c.req('PUT', p, b ?? {}, o),
  };
  return c;
}

export const GOOD_PW = 'Correct-Horse-Battery-9';
let n = 0;
export const uniqueEmail = () => `aluno${++n}@example.com`;

export async function register(client, email = uniqueEmail(), password = GOOD_PW) {
  const r = await client.post('/api/auth/register', { email, password, acceptTerms: true, confirmAge: true });
  return { ...r, email, password };
}
