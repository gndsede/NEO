import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * Trilha de auditoria genérica (LGPD Art. 37; ISO 27001 A.8.15; OWASP A09:2021).
 *
 * Escrita best-effort: uma falha ao gravar auditoria NUNCA derruba a operação
 * de negócio — é logada no stderr para captura pela plataforma (Railway).
 *
 * O que registrar (mutações sensíveis):
 *  - exportações de relatórios com PII (quem, quando, filtros, formato);
 *  - login bem-sucedido e falho (web e mobile);
 *  - ativação/desativação de 2FA;
 *  - criação/edição de usuários e mudança de permissões;
 *  - anonimização/exclusão de titulares (LGPD Art. 18).
 */

export type AuditAction =
  | "EXPORT_WORKERS_PII"
  | "EXPORT_COMPLIANCE_PII"
  | "EXPORT_ACCESS_PII"
  | "EXPORT_CONTRACTOR_PENDING"
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGIN_MOBILE_SUCCESS"
  | "TWO_FA_ENABLED"
  | "TWO_FA_DISABLED"
  | "TWO_FA_BACKUP_CODE_USED"
  | "TWO_FA_BACKUP_CODES_REGENERATED"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_PERMISSIONS_CHANGED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_COMPLETED"
  | "WORKER_ANONYMIZED";

export interface AuditEntry {
  action: AuditAction;
  companyId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** IP de origem — passe `req` em vez disso quando disponível. */
  ip?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Extrai os campos de contexto de uma Request autenticada (ou não). */
export function auditContext(req: Request): Pick<AuditEntry, "companyId" | "actorId" | "actorEmail" | "ip"> {
  return {
    companyId: req.user?.companyId ?? null,
    actorId: req.user?.id ?? null,
    actorEmail: req.user?.email ?? null,
    ip: req.ip ?? null,
  };
}

/** Grava um evento de auditoria. Nunca lança — best-effort. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        companyId: entry.companyId ?? null,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        ip: entry.ip ?? null,
        meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] falha ao gravar trilha de auditoria:", err);
  }
}
