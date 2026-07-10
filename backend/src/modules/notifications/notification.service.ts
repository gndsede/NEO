import { Resend } from "resend";
import { type NotificationType } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { escapeHtml } from "../../lib/html-escape.js";

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY);
  return _resend;
}

async function hasRecentNotification(
  targetId: string,
  type: NotificationType,
  recipientEmail: string,
  windowHours: number,
): Promise<boolean> {
  const since = new Date(Date.now() - windowHours * 3_600_000);
  const existing = await prisma.notificationLog.findFirst({
    where: { targetId, type, recipientEmail, sentAt: { gte: since } },
    select: { id: true },
  });
  return !!existing;
}

async function sendEmail(params: {
  companyId: string;
  type: NotificationType;
  targetType: string;
  targetId: string;
  recipientEmail: string;
  subject: string;
  html: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const { error } = await resend.emails.send({
    from: `NEO - Soluções Civis <${env.NOTIFICATION_FROM_EMAIL}>`,
    to: [params.recipientEmail],
    subject: params.subject,
    html: params.html,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[notifications] falha ao enviar email:", error);
    return;
  }

  await prisma.notificationLog.create({
    data: {
      companyId: params.companyId,
      type: params.type,
      targetType: params.targetType,
      targetId: params.targetId,
      recipientEmail: params.recipientEmail,
    },
  });
}

// ---------------------------------------------------------------------------
// Notificação de rejeição (imediata)
// ---------------------------------------------------------------------------

export interface RejectionNoticeInput {
  companyId: string;
  documentId: string;
  workerName: string;
  documentName: string;
  rejectionReason: string;
  contractorName: string;
  contractorEmail: string;
}

export async function sendRejectionNotice(
  ctx: RejectionNoticeInput,
): Promise<void> {
  // Uma rejeição = um email; não reenviar para o mesmo documento
  const alreadySent = await hasRecentNotification(
    ctx.documentId,
    "DOCUMENT_REJECTED",
    ctx.contractorEmail,
    24 * 365,
  );
  if (alreadySent) return;

  await sendEmail({
    companyId: ctx.companyId,
    type: "DOCUMENT_REJECTED",
    targetType: "document",
    targetId: ctx.documentId,
    recipientEmail: ctx.contractorEmail,
    subject: `Documento reprovado — ${ctx.workerName}`,
    html: rejectionTemplate(ctx),
  });
}

// ---------------------------------------------------------------------------
// Digest de vencimento (agendado)
// ---------------------------------------------------------------------------

export interface ExpiryItem {
  workerOrContractorName: string;
  documentName: string;
  expiresAt: Date;
}

export interface ExpiryDigestInput {
  companyId: string;
  contractorId: string;
  contractorName: string;
  contractorEmail: string;
  items: ExpiryItem[];
  expired: boolean; // true = já vencido, false = vencendo em 7 dias
}

export async function sendExpiryDigest(ctx: ExpiryDigestInput): Promise<void> {
  const type: NotificationType = ctx.expired
    ? "DOCUMENT_EXPIRED"
    : "DOCUMENT_EXPIRING_7D";
  // EXPIRED: renotifica a cada 24h; EXPIRING: a cada 7 dias
  const windowHours = ctx.expired ? 24 : 7 * 24;

  const alreadySent = await hasRecentNotification(
    ctx.contractorId,
    type,
    ctx.contractorEmail,
    windowHours,
  );
  if (alreadySent) return;

  const subject = ctx.expired
    ? `Documentos vencidos — ${ctx.contractorName}`
    : `Documentos vencendo em 7 dias — ${ctx.contractorName}`;

  await sendEmail({
    companyId: ctx.companyId,
    type,
    targetType: "contractor_digest",
    targetId: ctx.contractorId,
    recipientEmail: ctx.contractorEmail,
    subject,
    html: expiryTemplate(ctx),
  });
}

// ---------------------------------------------------------------------------
// Templates HTML
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toLocaleDateString("pt-BR");
}

function baseLayout(content: string): string {
  return `<!DOCTYPE html>
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
        <tr><td style="padding:32px;">${content}</td></tr>
        <tr>
          <td style="background:#f4f5f7;padding:16px 32px;text-align:center;">
            <span style="color:#9ca3af;font-size:12px;">Este é um email automático — não responda a esta mensagem.</span>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function rejectionTemplate(ctx: RejectionNoticeInput): string {
  return baseLayout(`
    <h2 style="color:#b91c1c;margin:0 0 16px;">Documento reprovado</h2>
    <p style="color:#374151;margin:0 0 8px;">Olá, <strong>${escapeHtml(ctx.contractorName)}</strong>.</p>
    <p style="color:#374151;margin:0 0 24px;">
      O documento <strong>${escapeHtml(ctx.documentName)}</strong> do colaborador
      <strong>${escapeHtml(ctx.workerName)}</strong> foi <strong style="color:#b91c1c;">reprovado</strong>.
    </p>
    <table width="100%" cellpadding="12" cellspacing="0" style="background:#fef2f2;border-radius:6px;margin-bottom:24px;">
      <tr>
        <td style="color:#374151;font-size:14px;">
          <strong>Motivo:</strong> ${escapeHtml(ctx.rejectionReason)}
        </td>
      </tr>
    </table>
    <p style="color:#374151;margin:0 0 8px;">
      Por favor, envie um novo documento o quanto antes para regularizar a situação
      e manter o acesso do colaborador liberado.
    </p>
  `);
}

function expiryTemplate(ctx: ExpiryDigestInput): string {
  const isExpired = ctx.expired;
  const titleColor = isExpired ? "#b91c1c" : "#b45309";
  const badgeColor = isExpired ? "#fef2f2" : "#fffbeb";
  const badgeText = isExpired ? "VENCIDO" : "VENCE EM 7 DIAS";
  const badgeTextColor = isExpired ? "#b91c1c" : "#b45309";

  const rows = ctx.items
    .map(
      (item) => `
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:10px 12px;color:#374151;font-size:14px;">${escapeHtml(item.workerOrContractorName)}</td>
        <td style="padding:10px 12px;color:#374151;font-size:14px;">${escapeHtml(item.documentName)}</td>
        <td style="padding:10px 12px;text-align:right;">
          <span style="background:${badgeColor};color:${badgeTextColor};font-size:12px;font-weight:bold;padding:2px 8px;border-radius:4px;">
            ${badgeText} — ${formatDate(item.expiresAt)}
          </span>
        </td>
      </tr>`,
    )
    .join("");

  const contractorNameSafe = escapeHtml(ctx.contractorName);
  const intro = isExpired
    ? `Os documentos abaixo da empreiteira <strong>${contractorNameSafe}</strong> estão <strong style="color:${titleColor};">vencidos</strong>. O acesso dos colaboradores pode estar bloqueado.`
    : `Os documentos abaixo da empreiteira <strong>${contractorNameSafe}</strong> vencem nos <strong style="color:${titleColor};">próximos 7 dias</strong>. Providencie a renovação para evitar bloqueio de acesso.`;

  return baseLayout(`
    <h2 style="color:${titleColor};margin:0 0 16px;">
      ${isExpired ? "Documentos vencidos" : "Documentos vencendo em breve"}
    </h2>
    <p style="color:#374151;margin:0 0 24px;">${intro}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;margin-bottom:24px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:10px 12px;text-align:left;color:#6b7280;font-size:13px;font-weight:600;">Colaborador</th>
          <th style="padding:10px 12px;text-align:left;color:#6b7280;font-size:13px;font-weight:600;">Documento</th>
          <th style="padding:10px 12px;text-align:right;color:#6b7280;font-size:13px;font-weight:600;">Situação</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#6b7280;font-size:13px;margin:0;">
      Acesse o portal NEO - Soluções Civis para enviar os documentos atualizados.
    </p>
  `);
}
