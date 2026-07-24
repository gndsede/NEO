import { Resend } from "resend";
import { env } from "../config/env.js";
import { escapeHtml } from "./html-escape.js";
import { logger } from "./logger.js";

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY);
  return _resend;
}

/**
 * Envia o e-mail de alerta de anomalia (regra de observabilidade) para o
 * destinatário configurado na AlertRule. Best-effort: se RESEND_API_KEY não
 * estiver configurado, não envia — a anomalia continua registrada como
 * AlertEvent no painel super-admin de qualquer forma.
 */
export async function sendAlertEmail(params: {
  recipientEmail: string;
  metric: string;
  threshold: number;
  currentValue: number;
  message: string;
}): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;

  const metricSafe = escapeHtml(params.metric);
  const messageSafe = escapeHtml(params.message);

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
          <td style="background:#b91c1c;padding:24px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.5px;">⚠ Alerta — NEO AccessHub</span>
          </td>
        </tr>
        <tr><td style="padding:32px;">
          <h2 style="color:#1a3557;margin:0 0 16px;">Métrica ${metricSafe} fora do esperado</h2>
          <p style="color:#374151;margin:0 0 24px;">${messageSafe}</p>
          <p style="color:#374151;margin:0 0 8px;"><strong>Valor atual:</strong> ${params.currentValue}</p>
          <p style="color:#374151;margin:0 0 24px;"><strong>Limite configurado:</strong> ${params.threshold}</p>
          <p style="color:#9ca3af;font-size:12px;margin:0;">
            Verifique o painel de Observabilidade no Super Admin para mais detalhes.
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
    subject: `⚠ Alerta: ${params.metric} acima do limite configurado`,
    html,
  });

  if (error) {
    logger.error("alert_email_failed", { err: error, metric: params.metric });
    return false;
  }

  return true;
}
