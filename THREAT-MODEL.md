# Modelo de ameaças — Agenda Escolar

Versão do documento: 2026-10-19. Escopo: o código deste repositório (Worker, Durable Object, front-end, service worker). Atualize este arquivo quando mudar algo em login, dados, avisos ou implantação.

## 1. O que protegemos (ativos)

| Ativo | Por que importa | Onde fica |
|---|---|---|
| Senhas | Reuso de senha em outros sites | Só a "impressão" (PBKDF2-SHA512 + PEPPER) na tabela `users` |
| Sessão (cookie `__Host-sid`) | Quem a tem, é a conta | Navegador (HttpOnly). No servidor só o SHA-256 do token |
| Anotações escolares | Dados de estudantes, possivelmente menores de 18 anos | Tabelas `items`, `materias` |
| Segredo TOTP | Segundo fator | `users.totp_secret`, cifrado (AES-GCM, chave derivada do PEPPER) |
| Códigos de recuperação | Dão acesso à conta | Só a impressão (HMAC com PEPPER) |
| `PEPPER` (segredo do servidor) | Sem ele os hashes não são verificáveis; com ele um vazamento do banco fica mais fácil de atacar | Segredo da Cloudflare, nunca no repositório |
| `VAPID_PRIVATE` | Permite enviar avisos em nome do site | Segredo da Cloudflare |
| Endereços de push | Quem os conhece pode enviar mensagens cifradas inúteis; não consegue ler nada | `push_subs` |
| Conta Cloudflare e GitHub do responsável | Controlam o código e os segredos | Fora do app |

## 2. Quem pode atacar (atores)

1. Pessoa anônima na internet (varredura, força bruta, injeção, abuso de cadastro).
2. Usuário autenticado malicioso (tenta ver ou alterar dados de outro, estourar limites).
3. Quem descobriu a senha de alguém (vazada em outro site).
4. Quem pegou o aparelho ou o cookie de alguém.
5. Site de terceiros tentando usar o navegador da vítima (CSRF, clickjacking).
6. Dependência ou ferramenta comprometida (cadeia de suprimentos).
7. Acesso indevido à conta Cloudflare/GitHub do responsável.

## 3. Fronteiras de confiança

```
Navegador ──HTTPS──▶ Worker (valida tudo) ──RPC──▶ Durable Object (SQLite)
                         │
                         ├──HTTPS──▶ serviços de push (lista fechada de domínios)
                         └──HTTPS──▶ Resend (só se o e-mail estiver configurado)
Cron horário ──▶ Worker (mesma validação e mesmos limites)
```

O navegador nunca fala com o Durable Object. Tudo que vem do navegador é tratado como não confiável e validado no Worker (`src/validate.js`), inclusive o que o próprio front-end já validou.

## 4. Ameaças e defesas (STRIDE)

| # | Ameaça | Defesa implementada | Onde / como foi testado |
|---|---|---|---|
| S1 | Adivinhar senhas (força bruta, credential stuffing) | Limite por IP, por (IP, e-mail) com atraso progressivo e por conta; senha mínima de 10 caracteres com lista de senhas comuns | `test/auth.test.mjs` |
| S2 | Descobrir quais e-mails têm conta | Login, recuperação e redefinição respondem igual para conta existente e inexistente, com hash falso para igualar o tempo. **Exceção conhecida:** o cadastro responde 409 para e-mail já usado (revela existência). Só se fecha com confirmação por e-mail (precisa de provedor de e-mail); risco aceito e limitado por 6 cadastros/hora por origem | `test/auth.test.mjs` (o tempo real não foi medido em produção) |
| S3 | Roubo ou fixação de sessão | Token aleatório de 256 bits, só o hash no banco, cookie `__Host-` HttpOnly Secure SameSite=Lax, nova sessão a cada login, todas encerradas ao trocar a senha | `test/auth.test.mjs`, `test/e2e.mjs` |
| S4 | Falsificar pedido a partir de outro site (CSRF) | Exige `Origin` igual ao do site (ou `Sec-Fetch-Site: same-origin`) e `Content-Type: application/json`; cookie SameSite=Lax | `test/auth.test.mjs` |
| T1 | Alterar dados de outra conta (IDOR/BOLA) | Toda consulta usa o `user_id` da sessão, nunca um id enviado pelo cliente | `test/sync.test.mjs` |
| T2 | Enviar campos extras (mass assignment) | Só os campos conhecidos são lidos e gravados | `test/sync.test.mjs` |
| T3 | Injeção SQL / poluição de protótipo | Consultas parametrizadas; ids restritos a `[A-Za-z0-9_-]{1,40}`; JSON lido sem copiar `__proto__` | `test/sync.test.mjs` |
| T4 | XSS (script injetado via título, matéria, observação) | Todo texto de usuário passa por `esc()` antes de entrar em HTML; CSP sem `unsafe-inline` e sem `unsafe-eval`; nada de `eval` | `test/static.test.mjs`, `test/e2e.mjs` (payloads reais no navegador) |
| T5 | SSRF pelo endereço de push | Só HTTPS, sem credenciais, porta 443, e só domínios do Google, Mozilla, Apple e Microsoft; `redirect: manual` | `test/push.test.mjs` |
| R1 | Negar ação sensível | Registro de segurança (login, troca de senha, 2FA, exclusão) sem e-mail, senha ou IP em claro; guardado 90 dias | `test/auth.test.mjs` |
| I1 | Vazar senha ou segredo em log, erro ou repositório | Erros inesperados só registram rota e tipo; `.gitignore`; varredura de segredos; servidor se recusa a funcionar sem PEPPER válido | `test/static.test.mjs`, `test/sync.test.mjs` |
| I2 | Vazar dados entre contas pelo aviso diário | O resumo de cada pessoa é montado só com as atividades dela | `test/push.test.mjs` |
| I3 | Dados sensíveis no cache do aparelho | O service worker nunca guarda `/api/*`; a API responde `Cache-Control: no-store` | `test/static.test.mjs` |
| D1 | Lotar o banco ou travar o servidor | Limites: 5000 atividades, 100 matérias, lote de 1000, corpo de 512 KB, 10 aparelhos de aviso, limites de pedidos por rota | `test/sync.test.mjs`, `test/push.test.mjs` |
| D2 | Criar contas em massa | Limite de cadastros por IP; `REGISTRATION_OPEN=false` fecha o cadastro | `test/auth.test.mjs` |
| E1 | Subir de privilégio | Não existe papel de administrador nem rota administrativa | revisão de código |
| E2 | Roubar conta por recuperação | Códigos de recuperação de uso único; link por e-mail só se configurado (30 min, uso único); reautenticação (senha e código 2FA) para ações sensíveis | `test/auth.test.mjs` |
| C1 | Clickjacking | `frame-ancestors 'none'` e `X-Frame-Options: DENY` | `test/static.test.mjs` |

## 5. Riscos que continuam (aceitos ou dependentes de você)

1. **Argon2id não é usado.** O ambiente de desenvolvimento não tinha como instalar Argon2 (nem WASM). Usamos PBKDF2-HMAC-SHA512 com 100.000 iterações (o máximo permitido pelo WebCrypto do Workers) mais o PEPPER. É um algoritmo aceito, porém mais fácil de atacar com placas de vídeo do que Argon2id. O formato do hash tem versão, então dá para migrar sem pedir nova senha (`needsRehash`).
2. **Trocar o PEPPER invalida todas as senhas, códigos de recuperação e segredos 2FA.** Só troque em caso de vazamento, sabendo que todas as contas precisarão ser recriadas ou recuperadas.
3. **Um único Durable Object guarda todos os usuários.** Serve bem para um grupo pequeno (turma, escola). Para milhares de usuários simultâneos é preciso dividir por conta.
4. **Plano gratuito da Cloudflare:** o cálculo da senha (PBKDF2) usa mais tempo de CPU do que o limite do plano gratuito costuma permitir (10 ms por pedido). Se o login falhar com erro 1102 / "exceeded CPU", use o plano pago de Workers. Não foi possível testar isso aqui.
5. **Senha perdida sem códigos de recuperação nem e-mail configurado = conta perdida.** É uma escolha de projeto (não há administrador que redefina senhas).
6. **Sem CAPTCHA/Turnstile.** Os limites por IP e por conta reduzem abuso, mas um atacante com muitos IPs pode criar contas em massa.
7. **Sem verificação de e-mail no cadastro** e sem e-mail de "login suspeito": exigem um serviço de envio de e-mail (Resend) configurado.
8. **O IP vem do cabeçalho `CF-Connecting-IP`**, que só é confiável quando o tráfego passa pela Cloudflare (é o caso de um Worker).
9. **Avisos em segundo plano** dependem de VAPID configurado e, no iPhone, do app instalado na tela de início. Não foi possível testar contra os serviços reais de push.
10. **Nenhuma revisão jurídica foi feita** nos textos de privacidade e termos.
