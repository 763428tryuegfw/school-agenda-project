# Plano de testes de segurança

## Automáticos (rodam com `npm test`, também no GitHub Actions)
| Arquivo | O que prova |
|---|---|
| `test/auth.test.mjs` | cadastro/login/logout, mensagens genéricas, atraso progressivo, sessões, troca de senha, recuperação, 2FA, exportar/excluir conta, auditoria sem dados pessoais |
| `test/sync.test.mjs` | exige sessão; isolamento entre contas (IDOR); mass assignment; validação (tipo, data, tamanho, id, lote atômico); SQL/HTML guardados como texto; `__proto__`; limite de 5000 itens |
| `test/push.test.mjs` | SSRF (hosts, http, credenciais, portas, IPs internos); limite de aparelhos; só o dono cancela; envio cifrado e assinado; 410 remove; cron por fuso/hora, uma vez por dia, isolamento, falhas e limite por rodada |
| `test/digest.test.mjs` | textos "dia X é prova/teste/apresentação/seminário", prazos próximos, semana, fusos, plurais, limites |
| `test/crypto.test.mjs` | PBKDF2, TOTP (RFC 6238), Web Push (vetor do RFC 8291), VAPID |
| `test/static.test.mjs` | HTML sem script/estilo/evento embutido, sem recursos externos, `esc()`, cabeçalhos/CSP, manifesto e ícones, service worker, `wrangler.jsonc` sem segredos, varredura de segredos, contraste WCAG AA |
| `test/review.test.mjs` | achados da revisão independente: corrida no login (200 tentativas simultâneas), IPv6 /64, teto de cadastro, tipo como lista, link de redefinição |
| `test/e2e.mjs` | navegador real (Chromium, celular e desktop): fluxo completo, XSS, cookie, CSP sem violações, teclado. Rodar: `PLAYWRIGHT_DIR=<node_modules do playwright> node test/e2e.mjs` |

## Manuais (depois de publicar — não foi possível testar fora do Cloudflare real)
1. Abrir `https://SEU-SITE/api/config` → deve mostrar JSON (se mostrar página em branco, o deploy está errado).
2. Criar conta, sair, entrar; conferir que a página inicial sem login não mostra dados.
3. Ativar avisos no celular (no iPhone: primeiro "Adicionar à Tela de Início"); tocar em "Enviar aviso de teste".
4. Conferir cabeçalhos em https://securityheaders.com e SSL Labs.
5. Verificar o tempo de login (PBKDF2 no plano gratuito pode estourar o limite de CPU; ver `DEPLOYMENT-SECURITY.md`).
6. Testar no Safari/iPhone e Firefox (o e2e automático só roda no Chromium).
