-- Migration: endurecimento de segurança (auditoria F11/F13).
-- 1) Trilha de auditoria genérica (LGPD Art. 37; ISO 27001 A.8.15; OWASP A09:2021).
-- 2) Códigos de backup do 2FA (hashes bcrypt de uso único).

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"         TEXT NOT NULL,
  "companyId"  TEXT,
  "actorId"    TEXT,
  "actorEmail" TEXT,
  "action"     TEXT NOT NULL,
  "entityType" TEXT,
  "entityId"   TEXT,
  "ip"         TEXT,
  "meta"       JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_companyId_createdAt_idx" ON "audit_logs"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "audit_logs_actorId_createdAt_idx"   ON "audit_logs"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "audit_logs_action_createdAt_idx"    ON "audit_logs"("action", "createdAt");

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpBackupCodes" JSONB;
