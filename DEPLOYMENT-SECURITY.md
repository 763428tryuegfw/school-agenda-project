# Segurança da implantação (Cloudflare + GitHub)

Versão: 2026-10-19. O passo a passo para leigos está em `LEIA-ME.txt`; aqui está o que precisa estar certo para ser seguro.

## Antes do primeiro deploy
- [ ] Verificação em duas etapas **ligada** na conta do GitHub e na da Cloudflare.
- [ ] `npm test` passa na sua máquina (Node 22 ou mais novo).
- [ ] `npm run secret` → valor guardado no gerenciador de senhas → cadastrado na Cloudflare como **Segredo** chamado `PEPPER`.
- [ ] (Avisos em segundo plano) `npm run vapid` → `VAPID_PRIVATE` como **Segredo**; `VAPID_PUBLIC` e `VAPID_SUBJECT` em `wrangler.jsonc` (`"mailto:seu-email"`).
- [ ] `CONTROLLER_NAME` e `CONTACT_EMAIL` preenchidos em `wrangler.jsonc` (aparecem na Política de Privacidade).
- [ ] Nenhum segredo no repositório: `node scripts/scan-secrets.mjs` (e o `.gitignore` já ignora `.dev.vars`).
- [ ] Repositório do GitHub com "Secret scanning" e "Push protection" ligados (Settings › Code security).

## Configuração na Cloudflare
- Comando de deploy: **`npx wrangler deploy`** (sem `--assets` nem outras opções; a configuração já está em `wrangler.jsonc`). Um comando antigo com `--assets` causava a página em branco.
- Variáveis e segredos: Workers › seu Worker › Configurações › Variáveis e segredos. Tipo **Segredo** para `PEPPER`, `VAPID_PRIVATE`, `RESEND_API_KEY`.
- Domínio: use o `*.workers.dev` ou um domínio próprio. Em domínio próprio, ligue "Sempre usar HTTPS" e "HSTS" na zona (o Worker já envia `Strict-Transport-Security`).
- Plano: o login usa PBKDF2 (CPU pesada). No plano gratuito pode aparecer erro de limite de CPU; nesse caso use o plano pago de Workers.
- Cron: `0 * * * *` (a cada hora) já está no `wrangler.jsonc`. Só envia avisos se o VAPID estiver configurado.

## Depois do deploy (verifique no navegador)
1. Abra `https://SEU-SITE/api/config`: deve mostrar um JSON (se aparecer página em branco ou erro, o deploy está errado).
2. Crie uma conta de teste, anote os 8 códigos, saia e entre de novo.
3. DevTools › Network: o cookie `__Host-sid` deve ser HttpOnly e Secure; o Console não deve ter erros de CSP.
4. Ative os avisos em "Conta e avisos" e use "Enviar aviso de teste".
5. Exclua a conta de teste.

## Cabeçalhos enviados (conferidos em `test/static.test.mjs`)
`Content-Security-Policy` (sem inline), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Cache-Control: no-store` na API. O HSTS não usa `includeSubDomains` nem `preload` de propósito (evita afetar outros subdomínios seus).

## Rotação de segredos
| Segredo | Quando trocar | Efeito |
|---|---|---|
| `PEPPER` | Só se houver vazamento do segredo **e** do banco | Invalida todas as senhas, códigos de recuperação e 2FA |
| `VAPID_PRIVATE` | Se vazar | Todos precisam reativar os avisos |
| `RESEND_API_KEY` | Se vazar | Nenhum impacto nos usuários |
| Tokens do GitHub/Cloudflare | A cada 90 dias e se vazarem | Nenhum |
