# Auditoria de segurança — resultado

Data: 2026-10-20. Método: análise do código + 87 testes automáticos + teste ponta a ponta em navegador + **revisão independente** feita por um segundo agente sem acesso às minhas conclusões (somente leitura). A revisão independente foi interrompida uma vez por erro do servidor e retomada; seus achados vieram de leitura de código (não de exploração); os que foram corrigidos agora têm teste.

## Achados da revisão independente
| # | Gravidade | Achado | Situação |
|---|---|---|---|
| A1 | Alta | Corrida no limite de login: tentativas simultâneas passavam do teto por conta | **Corrigido e testado** (reserva atômica antes de verificar a senha; teste com 200 tentativas simultâneas) |
| M1 | Média | Atacante que só sabe o e-mail pode trancar a conta por 1 h (acima de 40 falhas); alunos no mesmo IP escolar ignoram esse teto | **Pendente (risco aceito)**: solução real exige desafio Turnstile ou cookie de dispositivo |
| M2 | Média | Teto global de cadastro gasto por pedidos inválidos; cadastro revela e-mail já usado | Teto: **corrigido e testado**. Enumeração no cadastro: **pendente** (precisa confirmação por e-mail) |
| M3 | Média | IPv6 completo burlava limites por origem | **Corrigido e testado** (usa o bloco /64) |
| M4 | Média | Um único Durable Object (gargalo/armazenamento) | **Pendente**: use o limite de taxa/WAF da Cloudflare; ver riscos residuais |
| B1 | Baixa | Aviso diário continua após sessão expirar/ser revogada | **Pendente**; mitigado: sair pelo botão cancela o aviso do aparelho |
| B2 | Baixa | `tipo` como lista causava erro 500 | **Corrigido e testado** |
| B3 | Baixa | Terceiro pode gastar tentativas de recuperação de outro e-mail | Pendente (risco aceito) |
| B4 | Baixa | Link de redefinição usava o endereço da requisição | **Corrigido e testado** (defina `PUBLIC_ORIGIN` em `vars`) |
| B5–B7 | Baixa | Tokens de redefinição pendentes após troca de senha; leitura de corpo sem `Content-Length`; troca de dono de inscrição push; dados antigos do navegador oferecidos a outra conta | Pendentes, impacto baixo |
| I1–I5 | Info | PBKDF2 100k (máximo da plataforma); mesma chave para vários usos; pseudônimos em limites; exportação sem auditoria; menores | Documentados |

Não foram encontrados: XSS, IDOR, injeção SQL, SSRF, CSRF, segredos no repositório.

## Checklist de 20 itens (resumo honesto)
| Item | Status |
|---|---|
| Login com e-mail e senha obrigatório | corrigido e testado |
| Armazenamento seguro de senha | corrigido e testado (PBKDF2, não Argon2id) |
| Sessão segura / logout / expiração | corrigido e testado |
| Proteção contra força bruta | corrigido e testado (com ressalvas M1/M3) |
| Recuperação de conta | corrigido e testado (e-mail: depende de configurar Resend, não testado com serviço real) |
| 2FA | corrigido e testado (sem QR code: chave manual) |
| Autorização entre contas | corrigido e testado |
| Validação de entrada | corrigido e testado |
| XSS / CSP | corrigido e testado |
| CSRF | corrigido e testado |
| Cabeçalhos de segurança | corrigido e testado (HSTS sem preload) |
| Segredos fora do repositório | corrigido e testado (varredura) |
| Logs e auditoria sem dados sensíveis | corrigido e testado |
| LGPD: exportar e excluir | corrigido e testado (exportação não inclui auditoria) |
| Política de Privacidade, Termos, Cookies | feito; **precisa de revisão jurídica e preencher nome/contato** |
| Aviso de idade/menores | declaração simples; verificação real pendente |
| Notificações (push) | corrigido e testado com simulação; **não testado com Chrome/Safari reais** |
| Acessibilidade (contraste, teclado) | corrigido e testado (AA; só Chromium) |
| Licença do logo e das fontes | **você precisa confirmar** a origem/licença do logo; fontes do sistema (sem terceiros) |
| Política de reembolso, cobrança, avaliações, cookies de rastreio | não se aplica (site gratuito, sem pagamento, sem rastreadores) |

## Riscos residuais (leia antes de divulgar o site)
- Argon2id não usado; PBKDF2 100k + pepper. Plano gratuito da Cloudflare (10 ms de CPU) pode recusar logins; o plano pago resolve.
- Um Durable Object atende todos os usuários: serve para turma/escola pequena; para muitos usuários, separar por usuário.
- Sem e-mail configurado: quem perder senha **e** códigos de recuperação perde a conta.
- Sem verificação de e-mail, sem Turnstile/CAPTCHA.
- Push em segundo plano e cron nunca foram testados contra serviços reais.
- iPhone só recebe push com o app instalado na Tela de Início.
