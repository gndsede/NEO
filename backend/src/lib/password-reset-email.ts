import { Resend } from "resend";
import { env } from "../config/env.js";

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY);
  return _resend;
}

/**
 * Envia o e-mail de redefinição de senha ("esqueci minha senha").
 * Best-effort: se RESEND_API_KEY não estiver configurado, não envia (mas não
 * falha a requisição — a resposta ao usuário é sempre genérica).
 */
export async function sendPasswordResetEmail(params: {
  recipientEmail: string;
  resetToken: string;
}): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;

  const link = `${env.FRONTEND_URL.replace(/\/$/, "")}/redefinir-senha?token=${encodeURIComponent(params.resetToken)}`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NEO - Soluções Civis</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#1a3557;padding:24px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.5px;">NEO - Soluções Civis</span>
          </td>
        </tr>
        <tr><td style="padding:32px;">
          <h2 style="color:#1a3557;margin:0 0 16px;">Redefinição de senha</h2>
          <p style="color:#374151;margin:0 0 24px;">
            Recebemos uma solicitação para redefinir a senha da sua conta no NEO AccessHub.
            Clique no botão abaixo para criar uma nova senha:
          </p>
          <p style="margin:0 0 24px;">
            <a href="${link}" style="display:inline-block;background:#1a3557;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold;">
              Redefinir minha senha
            </a>
          </p>
          <p style="color:#9ca3af;font-size:12px;margin:0;">
            Este link expira em 1 hora. Se você não solicitou esta redefinição, ignore este e-mail —
            sua senha permanecerá inalterada.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from: `NEO - Soluções Civis <${env.NOTIFICATION_FROM_EMAIL}>`,
    to: [params.recipientEmail],
    subject: "Redefinição de senha — NEO AccessHub",
    html,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[password-reset-email] falha ao enviar e-mail:", error);
    return false;
  }

  return true;
}
