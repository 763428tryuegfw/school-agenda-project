// Envio opcional de e-mail de redefinição de senha (Resend). Só funciona se RESEND_API_KEY e MAIL_FROM
// estiverem configurados; sem eles o app oferece apenas os códigos de recuperação.
export const mailConfigured = (env) => !!(env.RESEND_API_KEY && env.MAIL_FROM);

export async function sendResetEmail(env, to, link, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [to],
      subject: 'Redefinir sua senha da Agenda Escolar',
      text: `Recebemos um pedido para redefinir a senha da sua conta na Agenda Escolar.\n\nAbra o link abaixo em até 30 minutos (ele só funciona uma vez):\n${link}\n\nSe você não pediu isso, ignore este e-mail: sua senha continua a mesma.`,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}
