// Servidor local de TESTE (não é o de produção). Usa o mesmo código da API, com o SQLite do Node no lugar do Durable Object.
// Rode:  node --disable-warning=ExperimentalWarning scripts/dev-server.mjs [porta] [arquivo.sqlite]
// Abra http://localhost:8787 no Chrome ou Firefox (o Safari não aceita o cookie seguro em http).
import http from 'node:http';
import { makeEnv } from '../test/helpers.mjs';
import { handle } from '../src/app.js';

const port = Number(process.argv[2] || 8787);
const file = process.argv[3] || ':memory:';
const { env } = makeEnv({ PEPPER: process.env.PEPPER || 'pepper-so-para-teste-local-pepper-so-para-teste-local' }, file);
if (process.env.VAPID_PUBLIC) Object.assign(env, { VAPID_PUBLIC: process.env.VAPID_PUBLIC, VAPID_PRIVATE: process.env.VAPID_PRIVATE, VAPID_SUBJECT: 'mailto:teste@example.com' });
env.CONTROLLER_NAME = process.env.CONTROLLER_NAME || '';
env.CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const r = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }), env, {});
  const out = {};
  r.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
  const sc = r.headers.getSetCookie();
  if (sc.length) out['set-cookie'] = sc;
  delete out['strict-transport-security'];            // HSTS não faz sentido em http://localhost
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`Agenda Escolar (teste local) em http://localhost:${port}`));
