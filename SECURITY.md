# Segurança — Agenda Escolar

## Como reportar uma falha
Escreva para o e-mail de contato configurado em `CONTACT_EMAIL` (aparece na Política de Privacidade do site) com: o que você viu, como repetir e o impacto. Não publique detalhes antes de haver correção. Não teste com dados de outras pessoas.

## Resumo das proteções
- **Acesso:** o conteúdo só abre depois de entrar com e-mail e senha. Senhas: PBKDF2-SHA512 (100 000 iterações, o máximo do Cloudflare Workers) + sal por usuário + pepper secreto. Argon2id **não** é usado (não há WebAssembly/dependências neste projeto); o formato do hash é versionado e `needsRehash` migra senhas no próximo login.
- **Sessão:** cookie `__Host-sid` (HttpOnly, Secure, SameSite=Lax), 256 bits aleatórios, só o hash fica no banco; expira por inatividade (14 dias) e no máximo em 60 dias; nova sessão a cada login; encerrada ao trocar a senha.
- **Força bruta:** limite por origem (IPv6 por bloco /64), por par origem+e-mail com atraso progressivo e por conta (reserva atômica da tentativa).
- **2FA opcional (TOTP)** e **8 códigos de recuperação** de uso único; recuperação por e-mail só se um provedor (Resend) for configurado.
- **Dados:** cada conta só enxerga os próprios dados (todas as consultas filtram pelo usuário da sessão); toda entrada é validada no servidor (tipos, tamanhos, datas reais, ids, lotes atômicos); campos desconhecidos são descartados.
- **Navegador:** CSP sem inline (`script-src 'self'`), HSTS, nosniff, DENY, sem referer, sem recursos de terceiros, texto do usuário sempre escapado.
- **Notificações:** Web Push criptografado (RFC 8291) com VAPID; só endereços https dos serviços de push conhecidos (defesa contra SSRF).
- **Privacidade (LGPD):** exportar e excluir a conta pelo próprio site; auditoria sem e-mail, senha ou IP em claro.

## O que NÃO está coberto / riscos que restam
Veja `SECURITY-AUDIT.md` (seção "Riscos residuais") e `THREAT-MODEL.md`.
