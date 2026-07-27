import { Resend } from "resend";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

let _resend: Resend | null = null;
let warnedMissingKey = false;

function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) {
    // Loga uma única vez por processo — sem isso, a ausência da chave em
    // produção fica invisível (o endpoint sempre responde 200 genérico).
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      logger.warn(
        "[password-reset-email] RESEND_API_KEY não configurada — e-mail de redefinição não será enviado",
      );
    }
    return null;
  }
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
  <meta name="color-scheme" content="light" />
  <title>NEO - Soluções Civis</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Use o link abaixo para criar uma nova senha. Ele expira em 1 hora.
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0f2f5;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px -8px rgba(0,42,79,.18);">
        <tr>
          <td style="height:4px;background:linear-gradient(90deg,#0099FF,#FF6B00);font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:32px 40px 24px;">
            <span style="color:#0a2a4a;font-size:17px;font-weight:700;letter-spacing:.2px;">NEO <span style="color:#0099FF;">Soluções Civis</span></span>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 36px;">
            <div style="display:inline-block;background:#eaf6ff;color:#0077cc;font-size:12px;font-weight:600;letter-spacing:.3px;padding:4px 10px;border-radius:999px;margin-bottom:18px;">
              REDEFINIÇÃO DE SENHA
            </div>
            <h1 style="color:#0a2a4a;font-size:21px;line-height:1.3;margin:0 0 14px;">Vamos criar uma nova senha</h1>
            <p style="color:#4b5563;font-size:14px;line-height:1.6;margin:0 0 28px;">
              Recebemos uma solicitação para redefinir a senha da sua conta no NEO AccessHub.
              Clique no botão abaixo para escolher uma nova senha de acesso.
            </p>
            <table cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td style="border-radius:8px;background:#0099FF;">
                  <a href="${link}" style="display:inline-block;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 28px;border-radius:8px;">
                    Redefinir minha senha
                  </a>
                </td>
              </tr>
            </table>
            <p style="color:#9aa3af;font-size:12px;line-height:1.6;margin:28px 0 0;">
              Ou copie e cole este link no navegador:<br />
              <a href="${link}" style="color:#0099FF;word-break:break-all;">${link}</a>
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:28px;background:#fff8ee;border:1px solid #ffe3bd;border-radius:8px;">
              <tr>
                <td style="padding:14px 18px;color:#8a5a1f;font-size:12.5px;line-height:1.6;">
                  ⏱ Este link expira em <strong>1 hora</strong>. Se você não solicitou esta redefinição,
                  ignore este e-mail — sua senha permanecerá inalterada.
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;background:#f7f9fb;border-top:1px solid #edf0f3;">
            <p style="color:#9ca3af;font-size:11.5px;margin:0;">
              NEO Soluções Civis · Este é um e-mail automático — não responda a esta mensagem.
            </p>
          </td>
        </tr>
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
    logger.error("[password-reset-email] falha ao enviar e-mail", { err: error });
    return false;
  }

  return true;
}
