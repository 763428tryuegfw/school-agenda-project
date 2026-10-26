# Backup e recuperação

Versão: 2026-10-19.

## O que existe hoje (honesto)

| Item | Situação |
|---|---|
| Código | Está no GitHub. Se o Worker for apagado, `git push` + `npx wrangler deploy` o recria. |
| Dados dos usuários | Ficam no Durable Object (SQLite) da Cloudflare. **Este projeto não faz backup automático para outro lugar.** |
| Cópia pela própria pessoa | Cada usuário pode baixar seus dados em "Conta e avisos" › "Meus dados" (arquivo JSON). Não existe "importar" desse arquivo; serve como cópia de segurança pessoal e para a LGPD. |
| Recuperação pontual da Cloudflare | Durable Objects com SQLite têm recuperação pontual (até 30 dias) pela API do objeto. **Este projeto não tem rota ou comando para usar isso**: seria preciso acrescentar um comando administrativo e fazer deploy. Não foi testado aqui. Confirme os detalhes na documentação atual da Cloudflare. |
| Senha esquecida | Códigos de recuperação (8, mostrados uma vez ao criar a conta) ou, se configurado, link por e-mail. Sem nenhum dos dois, a conta não tem como ser recuperada (não existe administrador que redefina). |
| Segredos | **Guarde `PEPPER` e `VAPID_PRIVATE` em um gerenciador de senhas.** Sem o PEPPER, nenhuma senha, código de recuperação ou segredo 2FA existente consegue ser verificado. |

## Risco que continua
Perda do banco = perda das anotações de todos. Para uma turma pequena, peça que cada pessoa baixe o arquivo de vez em quando. Para algo maior, o próximo passo é um comando administrativo que exporte o banco para o R2 ou use a recuperação pontual.

## Como restaurar o serviço do zero
1. Clone o repositório e rode `npm test` (deve passar tudo).
2. `npx wrangler deploy` (cria o Worker e o Durable Object vazio).
3. Recadastre os segredos no painel (`PEPPER`, `VAPID_PRIVATE`, e `RESEND_API_KEY` se usava). **Use o mesmo PEPPER de antes** se for restaurar dados antigos; com um novo, as contas antigas não conseguem entrar.
4. Avise os usuários que o histórico pode ter se perdido.

## Teste de restauração
Nunca foi feito contra o ambiente real da Cloudflare. Faça um ensaio antes de depender disso: crie uma conta de teste, apague e recrie o Worker em outro nome, e confira o que sobrou.
