# Resposta a incidentes

Versão: 2026-10-19. Para quem opera o site. Mantenha a calma e anote data, hora e o que você fez em cada passo.

## 0. Primeiros 15 minutos (qualquer incidente)
1. **Feche novos cadastros** se houver abuso: em `wrangler.jsonc`, `"REGISTRATION_OPEN": "false"`, `git push`, `npx wrangler deploy`.
2. **Se o site precisa parar agora:** painel Cloudflare › Workers › seu Worker › "Desativar rota/subdomínio" (ou apague o Worker; o código continua no GitHub).
3. Guarde evidências: no painel, Workers › Logs. O banco guarda eventos de segurança por 90 dias (sem e-mails, senhas ou IPs em claro).

## 1. Cenários

### A. Vazou o `PEPPER`
- Impacto: quem tiver também uma cópia do banco consegue testar senhas mais rápido (as senhas continuam protegidas por PBKDF2).
- Ação: trocar o PEPPER **invalida todas as senhas, códigos de recuperação e segredos 2FA**. Só faça se o banco também vazou. Gere um novo (`npm run secret`), cadastre no painel e avise todos que precisam criar a conta de novo.

### B. Vazou o `VAPID_PRIVATE`
- Impacto: alguém pode enviar avisos falsos aos aparelhos inscritos.
- Ação: `npm run vapid`, troque `VAPID_PRIVATE` (segredo) e `VAPID_PUBLIC` (`wrangler.jsonc`), deploy. Os usuários precisam reativar os avisos (as inscrições antigas deixam de valer).

### C. Vazou a chave do Resend (`RESEND_API_KEY`)
- Revogue a chave no painel do Resend, crie outra, cadastre como segredo.

### D. Conta de usuário invadida
- Peça que a pessoa entre (ou recupere a conta), vá em "Conta e avisos" › "Sair de todos os outros aparelhos", troque a senha (isso encerra todas as sessões) e ative a verificação em duas etapas.
- Se ela não consegue entrar: use o código de recuperação. Sem código e sem e-mail configurado, não há como recuperar a conta; a pessoa cria outra.

### E. Vazamento ou acesso indevido ao banco
- Troque as chaves de API/senha das contas Cloudflare e GitHub, ative verificação em duas etapas nelas, revise "Membros" e tokens de API.
- Siga a seção 2.

### F. Código malicioso no repositório (dependência ou commit)
- O projeto não tem dependências de execução. Verifique `git log` e o último deploy. Reverta: `git revert` e deploy. Troque tokens do GitHub e da Cloudflare.

## 2. Comunicação (LGPD)
Se houve acesso indevido a dados pessoais que possa causar risco ou dano relevante aos titulares: comunicar a ANPD e os titulares (LGPD art. 48). O prazo e o formato são definidos em regulamento da ANPD (a Resolução CD/ANPD nº 15/2024 fala em 3 dias úteis). **Confirme o prazo atual e o texto com assessoria jurídica.** Como o público inclui menores, trate como prioridade.

O que informar: o que aconteceu, quais dados (e-mail, anotações; senhas nunca ficam em claro), quando, o que já foi feito e o que a pessoa deve fazer (trocar a senha neste e em outros sites onde reutilizou).

## 3. Depois
Registre a causa, o que mudou para evitar de novo e atualize `THREAT-MODEL.md` e `SECURITY-AUDIT.md`.
