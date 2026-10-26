// Ponto de entrada do Cloudflare Worker.
import { handle, runScheduled } from './app.js';
export { AppDB } from './do.js';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env).then(
      (r) => console.log(JSON.stringify({ evt: 'cron', ...r })),
      () => console.error(JSON.stringify({ evt: 'cron_failed' })),
    ));
  },
};
