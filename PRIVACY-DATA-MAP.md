# Mapa de dados pessoais (LGPD) — Agenda Escolar

Versão: 2026-10-23 (documentos legais: 2026-10-23). Este mapa descreve o que o código realmente faz. Ele **não substitui** revisão jurídica. Complete `CONTROLLER_NAME` e `CONTACT_EMAIL` em `wrangler.jsonc` para que a Política de Privacidade mostre o responsável e o contato.

## 1. Dados tratados

| Dado | Finalidade | Base legal (a validar) | Onde fica | Quanto tempo | Quem acessa |
|---|---|---|---|---|---|
| E-mail | Identificar a conta, entrar, (opcional) enviar link de redefinição | Execução do serviço (art. 7º, V) | `users.email` (minúsculas, normalizado) | Até excluir a conta | A própria pessoa; o operador do Worker tecnicamente |
| Impressão da senha | Autenticar | Execução do serviço | `users.pw_hash` | Até excluir/trocar | Ninguém lê a senha; só dá para verificar |
| Atividades, matérias, notas, observações | O serviço em si | Execução do serviço | `items`, `materias` | Até a pessoa apagar ou excluir a conta | A própria pessoa |
| Segredo do app autenticador (opcional) | Verificação em duas etapas | Execução do serviço / segurança | `users.totp_secret` cifrado | Até desativar ou excluir | Só o servidor, ao verificar |
| Impressão dos códigos de recuperação | Recuperar a conta | Segurança | `recovery_codes` | Até usar, regenerar ou excluir | Só o servidor |
| Sessões: impressão do token, datas, resumo do aparelho ("Chrome · Mac"), impressão do IP | Manter a pessoa conectada e permitir encerrar sessões | Segurança (legítimo interesse, art. 7º, IX) | `sessions` | 14 dias sem uso ou 60 dias de idade | A própria pessoa vê a lista |
| Inscrição de aviso (endereço do navegador, chaves públicas, hora, fuso) | Enviar avisos de prazo | Consentimento (art. 7º, I) | `push_subs`, `users.notif_*` | Até desativar, excluir a conta, ou 5 falhas seguidas de envio | Servidor; serviço de push do navegador recebe o endereço e a mensagem cifrada |
| Registro de segurança (evento, data, impressão do IP) | Detectar abuso e investigar incidentes | Legítimo interesse | `audit` | 90 dias | Operador do Worker |
| Arquivos anexados (conteúdo, nome, tipo, tamanho, data, ligação com atividade/matéria) | Guardar e mostrar os anexos que a pessoa enviou | Execução do serviço (art. 7º, V) | Tabelas `files` e `file_chunks` (Durable Object SQLite, pedaços de 1 MB, impressão sha256) | Até a pessoa apagar o arquivo ou excluir a conta. Apagar a atividade NÃO apaga o arquivo: ele passa para a matéria | Só a própria conta (outras recebem 404); o operador do Worker tecnicamente |
| Escolha sobre cookies (aceitar/recusar opcionais, data, histórico) | Lembrar a escolha | Necessário para respeitar a escolha | Só no aparelho (`localStorage`, chave `agenda-cookies`); nunca vai ao servidor | Até a pessoa apagar os dados do navegador | A própria pessoa |
| Aceite dos termos (versão e data) | Prova de aceite | Obrigação / exercício regular de direitos | `users.terms_*` | Até excluir a conta | Operador |

**Não coletamos:** nome, telefone, escola, data de nascimento, localização, cookies de publicidade ou de estatística, nada de terceiros. Fontes do sistema (nenhuma é baixada de terceiros).

## 2. Compartilhamento

| Com quem | O quê | Quando |
|---|---|---|
| Cloudflare (operadora) | Hospedagem e banco de dados | Sempre. Processamento pode ocorrer fora do Brasil |
| Google / Apple / Mozilla / Microsoft (serviços de push) | Endereço da inscrição e mensagem cifrada | Só se a pessoa ativar avisos |
| Resend | E-mail do destinatário e o link | Só se o responsável configurar `RESEND_API_KEY` e `MAIL_FROM` |

Sem venda de dados, sem publicidade, sem rastreadores.

## 3. Direitos do titular e como são atendidos no app

| Direito (LGPD art. 18) | Como |
|---|---|
| Confirmação e acesso | "Conta e avisos" › "Meus dados" › baixar arquivo (`GET /api/account/export`, JSON) |
| Correção | Editar as anotações no app |
| Eliminação | "Excluir minha conta" (pede senha e a palavra EXCLUIR; apaga conta, anotações, sessões, códigos e avisos na hora; os registros de segurança já existentes ficam até 90 dias sem ligação com a conta) |
| Revogar consentimento | "Desativar avisos" |
| Portabilidade | O mesmo arquivo JSON |
| Outros pedidos | Pelo contato configurado em `CONTACT_EMAIL` |

## 4. Crianças e adolescentes

O cadastro exige declarar 12 anos ou mais e, para menores de 18, que o responsável concorda (campos `acceptTerms` e `confirmAge`, validados no servidor). O app não usa publicidade nem perfilamento. **Ponto jurídico em aberto:** a LGPD (art. 14) exige atenção ao melhor interesse da criança e consentimento específico de um responsável para menores de 12 anos; o app apenas **proíbe** o cadastro abaixo de 12 anos por declaração, sem verificar. Valide com assessoria jurídica antes de divulgar para o público.

## 5. Incidentes
Veja `INCIDENT-RESPONSE.md` (inclui o aviso à ANPD e aos titulares).

## 6. Anexos: limites e exportação (2026-10-23)
- Limites: 20 MB por arquivo, 100 MB e 100 arquivos por conta, 10 por atividade. O servidor confere o tipo pelo conteúdo, o nome, o tamanho e o dono.
- Exportação (`/api/account/export`): inclui `arquivos_enviados` com nome, tipo, tamanho, matéria, atividade e data. **O conteúdo binário não vai no JSON**; cada arquivo é baixado pela lista de anexos.
- Exclusão da conta apaga arquivos e pedaços. Não há varredura de vírus.
- Capacidade: o armazenamento é o SQLite do Durable Object (limite da Cloudflare por objeto). Com 100 MB por conta e um único objeto para todas as contas (item M4 da `SECURITY-AUDIT.md`), muitas contas com anexos podem esgotar a capacidade. Se o uso crescer, mover os arquivos para R2 (precisa criar o bucket no painel da Cloudflare).

## 7. Cookies e consentimento
- Único cookie: `__Host-sid` (necessário). Nenhum cookie ou rastreador opcional existe hoje.
- `public/consent.js` mostra o aviso com "Aceitar opcionais" e "Recusar opcionais" iguais, guarda a escolha só no aparelho e expõe `optionalAllowed()`. Qualquer recurso opcional futuro deve chamar essa função antes de ligar e a política de cookies deve ser atualizada junto (a versão em `CONSENT_VERSION` sobe e o aviso volta a perguntar).
- Mudar a escolha: botão "Preferências de cookies" no rodapé de todas as telas.
