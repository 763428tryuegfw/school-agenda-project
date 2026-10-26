/* Service worker da Agenda Escolar.
   1) Guarda os arquivos do site para a tela abrir mesmo sem internet.
   2) Mostra os avisos enviados pelo servidor (push), mesmo com o app fechado.
   Nunca guarda respostas da API (/api/*): os dados da conta só vêm da rede, com a sessão ativa. */
const CACHE = 'agenda-escolar-v8';
const CORE = ['./', './index.html', './app.css', './app.js', './digest.js', './uploads.js', './legal.js', './consent.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-32.png', './logo-96.png', './badge-72.png',
  './privacidade.html', './termos.html', './cookies.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Rede primeiro (para correções chegarem logo); se estiver sem internet, usa o que foi guardado.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req).then((resp) => {
      if (resp && resp.ok && resp.type === 'basic') { const copia = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
      return resp;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

self.addEventListener('push', (e) => {
  let d = null;
  try { d = e.data ? e.data.json() : null; } catch (err) { d = null; }
  const title = clip(d && d.title, 120) || 'Agenda Escolar';
  const body = clip(d && d.body, 700) || 'Abra a agenda para ver seus prazos.';
  const tag = clip(d && d.tag, 60) || 'agenda-resumo';
  e.waitUntil(self.registration.showNotification(title, { body, tag, icon: 'icon-192.png', badge: 'badge-72.png', lang: 'pt-BR' }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
