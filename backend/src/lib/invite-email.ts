import { Resend } from "resend";
import { env } from "../config/env.js";
import { escapeHtml } from "./html-escape.js";

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY);
  return _resend;
}

/**
 * Envia o e-mail de convite para o primeiro administrador de um tenant recém
 * criado pelo super-admin. Best-effort: se RESEND_API_KEY não estiver
 * configurado, não envia (mas não falha a criação do tenant).
 */
export async function sendTenantInviteEmail(params: {
  recipientEmail: string;
  companyName: string;
  inviteToken: string;
}): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;

  const link = `${env.FRONTEND_URL.replace(/\/$/, "")}/aceitar-convite?token=${encodeURIComponent(params.inviteToken)}`;
  const companyNameSafe = escapeHtml(params.companyName);

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
          <h2 style="color:#1a3557;margin:0 0 16px;">Bem-vindo(a) ao NEO AccessHub</h2>
          <p style="color:#374151;margin:0 0 24px;">
            Sua empresa <strong>${companyNameSafe}</strong> foi cadastrada na plataforma.
            Defina sua senha de acesso para começar:
          </p>
          <p style="margin:0 0 24px;">
            <a href="${link}" style="display:inline-block;background:#1a3557;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold;">
              Definir minha senha
            </a>
          </p>
          <p style="color:#9ca3af;font-size:12px;margin:0;">
            Este link expira em 7 dias. Se você não esperava este e-mail, ignore-o.
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
    subject: "Bem-vindo(a) ao NEO AccessHub — defina sua senha",
    html,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[invite-email] falha ao enviar convite:", error);
    return false;
  }

  return true;
}

/**
 * Envia o e-mail de convite para um usuário comum cadastrado por um admin do
 * tenant (tela "Cadastro de Usuário"). Best-effort: se RESEND_API_KEY não
 * estiver configurado, não envia (mas não falha o cadastro do usuário).
 */
export async function sendUserInviteEmail(params: {
  recipientEmail: string;
  recipientName: string;
  companyName: string;
  inviteToken: string;
}): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;

  const link = `${env.FRONTEND_URL.replace(/\/$/, "")}/aceitar-convite?token=${encodeURIComponent(params.inviteToken)}`;
  const recipientNameSafe = escapeHtml(params.recipientName);
  const companyNameSafe = escapeHtml(params.companyName);

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
          <h2 style="color:#1a3557;margin:0 0 16px;">Bem-vindo(a), ${recipientNameSafe}</h2>
          <p style="color:#374151;margin:0 0 24px;">
            Você foi cadastrado(a) na plataforma NEO AccessHub pela empresa <strong>${companyNameSafe}</strong>.
            Defina sua senha de acesso para começar:
          </p>
          <p style="margin:0 0 24px;">
            <a href="${link}" style="display:inline-block;background:#1a3557;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold;">
              Definir minha senha
            </a>
          </p>
          <p style="color:#9ca3af;font-size:12px;margin:0;">
            Este link expira em 7 dias. Se você não esperava este e-mail, ignore-o.
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
    subject: "Você foi convidado(a) para o NEO AccessHub — defina sua senha",
    html,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[invite-email] falha ao enviar convite de usuário:", error);
    return false;
  }

  return true;
}
