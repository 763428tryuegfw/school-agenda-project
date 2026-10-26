// Preenche nas páginas legais o nome do responsável e o contato, configurados no servidor (wrangler.jsonc).
(async () => {
  let c = {};
  try { const r = await fetch('/api/config', { cache: 'no-store', credentials: 'same-origin' }); c = await r.json(); } catch (e) { /* offline: mantém os textos padrão */ }
  document.querySelectorAll('[data-controller]').forEach((el) => { el.textContent = c.controllerName || '[nome do responsável: ainda não informado pelo site]'; });
  document.querySelectorAll('[data-contact]').forEach((el) => { el.textContent = c.contactEmail || '[e-mail de contato: ainda não informado pelo site]'; });
  document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = c.termsVersion || ''; });
})();
