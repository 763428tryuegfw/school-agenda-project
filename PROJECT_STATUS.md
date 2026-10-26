# PROJECT_STATUS — Agenda Escolar

Atualizado em 2026-10-21.

## Pronto e testado (versão anterior, entregue em agenda-escolar-final.zip)
- Login e senha, notificações, novos tipos de atividade, segurança, documentos.
- 87 testes automáticos e 13 passos no navegador passando.

## Etapa 1 CONCLUÍDA (2026-10-22): servidor dos arquivos — sem tela ainda
- Arquivos: `src/files.js` (validação pelo conteúdo, limites, nome seguro, Range), `src/store.js` (tabelas `files` e `file_chunks`, cota, exclusão, exportação), `src/do.js`, `src/app.js` (rotas `POST/GET /api/files`, `GET/DELETE /api/files/:id`), `src/validate.js`, `test/files.test.mjs`, `test/helpers.mjs`.
- Correção desta etapa: nome de arquivo ".png" virava "png" (agora "arquivo.png").
- Testes: 102 de 102 passando (15 novos de arquivos: bytes idênticos, persistência, permissões entre contas, CSRF, tipos perigosos recusados, cotas, Range, exclusão, tudo-ou-nada, exclusão de conta).
- NÃO testado: Cloudflare real (Durable Object de verdade) e navegador (ainda não há tela).
- Ainda faltam para a Etapa 2 (tela): `media-src 'self'` e `blob:` em `img-src` na CSP, `uploads.js` no cache do service worker.

## DECISÃO DE HOSPEDAGEM (2026-10-22): GitHub + Cloudflare
- O usuário precisa de login, upload e avisos funcionando; GitHub Pages não tem servidor, então ele aceitou usar a Cloudflare (código no GitHub, a Cloudflare publica a cada push). O servidor atual (`src/`) é exatamente o que isso exige; nada a refazer.

## Etapa atual: upload de arquivos (tela)
Decisões já tomadas com o usuário:
- Dois uploads, na aba "Nova atividade", no lado direito dos formulários (ver captura de tela do usuário):
  1. dentro do formulário "Anotar atividade" (entre "Tipo" e "Observação");
  2. dentro de "Distribuição da nota" (ao lado de "Matéria" / "Itens da nota").
- Visual: cesta de basquete (vídeo "Basketball upload"): área tracejada, arquivo "arremessado", barra de progresso, "enviado com sucesso", contador "Enviados N".
- Aceitar foto, PDF, vídeo e outros arquivos. Armazenamento: dentro do Durable Object atual (sem configurar nada novo), em pedaços; limites sugeridos 20 MB por arquivo, 100 MB por conta.
- Arquivos privados: só o dono acessa, via /api/files/:id com sessão; tipo validado pelo conteúdo no servidor; nome interno aleatório.
- Listar os arquivos depois de salvar (na atividade e na matéria), com abrir/baixar/remover.

## Próximas etapas (aguardam autorização do usuário)
1. Login com visual do vídeo "Most Secure Login Form".
2. Banner de cookies com aceitar/recusar real e Política de Privacidade atualizada para uploads.
3. Pendências do checklist de publicação: página 404, og:image, robots.txt, sitemap.xml, rodapé com responsável, PageSpeed, links, domínio próprio.

## Regra do projeto
Não destruir o que já funciona: preservar telas, regras, dados e o cálculo das notas. Trabalhar em etapas pequenas e não avançar sem autorização.

## Etapa 3 (23/10/2026): anexos em "Distribuição da nota"
- `public/uploads.js`: a mesma caixa de upload agora tem dois escopos (`item` e `materia`). Arquivos escolhidos em cada caixa ficam separados e vão ao servidor com `X-Scope`. Novo: `afterSaveMateria`, `matChip`, `openMateria`, `hasStaged`.
- `public/index.html`: `#form-dist` ganhou a coluna da direita (`#up-dist`), igual à de "Anotar atividade". Campos e ids antigos intactos. Removida a janela `#arq` duplicada (defeito da Etapa 2).
- `public/app.js`: só liga a caixa nova, envia os arquivos após salvar a distribuição e mostra "Anexos da matéria (N)" na aba Matérias. Cálculo e distribuição de notas NÃO foram tocados.
- `public/sw.js`: cache v7.
- Testes: 102 unitários ok; navegador 22/22 (3 passos novos: anexar na distribuição, abrir/baixar na aba Matérias, apagar).
- Decisão pendente do usuário: hoje, ao apagar uma atividade, os anexos dela passam para a matéria (não são apagados). O checklist do Codex pede apagar junto. Aguardando escolha.
- Pendente: privacidade/cookies, login estilo vídeo, 404, Lighthouse, domínio/HTTPS, segredos no painel.

## Etapa 4a (23/10/2026): privacidade, termos e aviso de cookies
- Novo `public/consent.js` + estilos em `app.css`: aviso com "Aceitar opcionais" e "Recusar opcionais" idênticos; escolha só em `localStorage` (`agenda-cookies`, com histórico); `optionalAllowed()` para qualquer recurso opcional futuro; "Preferências de cookies" no rodapé de todas as telas. Hoje não há cookie nem rastreador opcional, e os textos dizem isso.
- `privacidade.html`, `termos.html`, `cookies.html`: anexos (nome, tipo, retenção, limites), exportação sem o conteúdo, passo a passo (baixar dados, apagar arquivo, excluir conta, pedir ajuda), cookies, histórico de versões. Responsável e contato seguem como texto entre colchetes até preencher `CONTROLLER_NAME` e `CONTACT_EMAIL` no `wrangler.jsonc`.
- `TERMS_VERSION` 2026-10-18 → 2026-10-23. Contas antigas mantêm o registro da versão que aceitaram.
- `sw.js`: cache v8, inclui `consent.js`. `PRIVACY-DATA-MAP.md` atualizado.
- Animação da cesta (arrastar mostra o arquivo na mão, trilha pontilhada, "Solte para arremessar!", arco até a cesta, rede balançando): já estava em `uploads.js`; conferida em navegador.
- Testes: 104 unitários; navegador 25/25 (aviso, mudar escolha, páginas legais).
- Pendente: revisão jurídica; preencher responsável/contato; decidir apagar anexos com a atividade.

## Etapa 4b (23/10/2026): login com etapas
- `public/index.html`: marca ✓ no e-mail válido (entrar e criar conta), painel de 3 etapas (Credenciais, Verificação de segurança, Autenticação), "Bem-vindo de volta!" e nota de proteção. Nenhum campo, botão ou fluxo antigo foi removido (2FA, recuperação, mostrar senha, criar conta continuam).
- `public/app.js`: `LOGIN_STEPS` só mostra o andamento real do login (servidor verificando, sessão criada); some em caso de erro; pausa de 650 ms para ver a mensagem (sem pausa se o sistema pede menos movimento). A lógica de autenticação não mudou.
- `public/app.css`: estilos novos no fim do arquivo. Mantida a paleta cinza do app (o tema escuro do vídeo não foi copiado, para preservar a identidade visual).
- Testes: 104 unitários; navegador 25/25 (passo de login estendido).
- Próximo: página 404 com status 404, robots/sitemap/metatags, Lighthouse, domínio, segredos.

## Etapa 5 (24/10/2026): prontidão para publicação
- Já existiam (feitos por outro processo, agora conferidos): `public/404.html`, `not_found_handling: "404-page"`, `/robots.txt` e `/sitemap.xml` gerados pelo Worker, metatags básicas.
- Novos testes (107 no total): página 404 com status 404 e cabeçalhos de segurança, API 404 em JSON, robots/sitemap (só páginas públicas, `/api/` escondido, POST = 405), wrangler com `404-page`.
- Medição local de desempenho/acessibilidade (Lighthouse não roda aqui) e varredura de segredos: sem segredos no repositório.
- Novo `PUBLICACAO-CHECKLIST.md`: cada item com estado e o que depende do usuário. App NÃO declarado pronto para publicar.
- Falta: `og:image` e `canonical` (precisam do domínio), domínio próprio, PageSpeed real, segredos no painel, responsável/contato, revisão jurídica, decisão sobre anexos ao apagar atividade.
