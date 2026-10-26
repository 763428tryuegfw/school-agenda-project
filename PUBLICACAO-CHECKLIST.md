# Checklist de publicação — Agenda Escolar

Atualizado em 24/10/2026. **O app NÃO está "100% pronto para publicar":** os itens marcados "depende de você" abaixo precisam ser feitos antes de divulgar. Nada foi publicado nem feito deploy.

Legenda: ✅ verificado aqui · ⚠️ verificado só em parte · ⏳ depende de você / do painel Cloudflare / de revisão jurídica.

| Item (lista do vídeo e do Codex) | Estado | Como foi verificado / o que falta |
|---|---|---|
| Abrir no celular e testar os fluxos | ⚠️ | Chromium emulando celular (390 px) e desktop: 25 passos de ponta a ponta (cadastro, entrar, atividades, anexos, matérias, cookies, 2FA). **Não testado em iPhone/Safari reais.** Teste você mesmo no iPhone depois do deploy. |
| Preencher e enviar os formulários, atividade com dois anexos | ✅ | Passos de navegador "anexos em Anotar atividade" (2 arquivos) e "Distribuição da nota" (2 arquivos). Falha de conexão e "Tentar de novo" também testados. |
| Link do WhatsApp | ✅ não existe | O app não tem nenhum link ou número de WhatsApp. Nada foi inventado. |
| Página 404 com status HTTP 404 | ⚠️ | `public/404.html` + `"not_found_handling": "404-page"` no `wrangler.jsonc`. Testes automáticos (107) confirmam página e status 404 localmente. **Falta confirmar na Cloudflare real** depois do deploy: `curl -I https://SEU-DOMINIO/qualquer-coisa` deve mostrar `404`. |
| Domínio próprio e HTTPS | ⏳ | Hoje só existe o endereço `*.workers.dev` (HTTPS automático). Para domínio próprio: Cloudflare > Workers > seu Worker > Configurações > Domínios e rotas > Adicionar > Domínio personalizado. O app envia HSTS (`max-age=31536000`). |
| PageSpeed / Lighthouse no domínio final | ⏳ | Lighthouse não roda neste ambiente. Medição local aproximada (rede lenta e CPU 4x mais lenta, sem compressão): 174 KB, 10 pedidos, primeira pintura ≈ 1,0 s, maior pintura ≈ 1,0 s, deslocamento de layout 0, sem imagens sem texto alternativo, sem campos sem rótulo, sem rolagem lateral. Rode https://pagespeed.web.dev no domínio final e guarde o resultado. |
| Segredos e variáveis de produção | ⏳ | `node scripts/scan-secrets.mjs`: nenhum segredo no repositório. No painel, cadastre como **Segredo**: `PEPPER` (gere com `node scripts/gen-secret.mjs`), `VAPID_PRIVATE` (`node scripts/gen-vapid.mjs`), e `RESEND_API_KEY` só se quiser recuperação por e-mail. Sem `PEPPER` o servidor recusa tudo (testado). |
| Responsável e contato reais na Política de Privacidade | ⏳ | `CONTROLLER_NAME` e `CONTACT_EMAIL` estão vazios em `wrangler.jsonc`. Enquanto vazios, as páginas mostram textos entre colchetes. Preencha e faça deploy. |
| Revisão jurídica | ⏳ | Base legal, foro e tratamento de menores estão marcados "a validar". Precisa de profissional. |
| `robots.txt` e `sitemap.xml` | ✅ | Gerados pelo Worker com o endereço real; escondem `/api/`; testados. |
| Metatags | ⚠️ | Título, descrição, `og:title`, `og:description`, `twitter:card` existem. **Faltam `og:image` e `canonical`**, que precisam do endereço final (e uma imagem de compartilhamento 1200×630). Faça depois de definir o domínio. |
| Decisão: apagar anexos junto com a atividade | ⏳ | Hoje os anexos passam para a matéria. A Política já descreve isso. Se você preferir apagar junto, avise e eu mudo código e texto. |
| Capacidade de armazenamento | ⏳ | Anexos ficam no SQLite do Durable Object (um objeto para todas as contas). Com muitos usuários enviando arquivos pode esgotar; o plano é mover os arquivos para R2 (criar o bucket no painel). Veja `PRIVACY-DATA-MAP.md` §6 e `SECURITY-AUDIT.md` M4. |
| Plano gratuito da Cloudflare | ⚠️ | A senha usa PBKDF2 de 100 mil iterações; no plano gratuito (10 ms de CPU) o login pode estourar o limite. Se der erro 1102 no login, é isso: plano pago resolve. Teste logo depois do deploy. |
| Avisos (push) no iPhone | ⚠️ | No iPhone o app precisa estar na Tela de Início para receber avisos. Não testado com serviços reais. |

## Passo a passo do deploy (quando você autorizar)
1. Preencher `CONTROLLER_NAME` e `CONTACT_EMAIL` em `wrangler.jsonc` e enviar ao GitHub.
2. No painel: cadastrar os segredos (`PEPPER`, `VAPID_PRIVATE`) e a variável `VAPID_PUBLIC` do `gen-vapid`.
3. Comando de deploy do painel: exatamente `npx wrangler deploy`.
4. Abrir `https://SEU-ENDERECO/api/config` — deve mostrar um JSON (se aparecer página em branco, o deploy não pegou este projeto).
5. Abrir um endereço que não existe e conferir a página 404 (`curl -I`).
6. Criar uma conta de teste no celular, anexar dois arquivos, sair e entrar de novo.
7. Rodar o PageSpeed no endereço final e guardar o resultado.
