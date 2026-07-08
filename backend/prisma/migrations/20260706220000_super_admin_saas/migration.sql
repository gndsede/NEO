-- Migration: Super-Admin SaaS — adiciona campos de gestão SaaS na Company
-- e cria tabelas de super-admins, contratos, faturas e tickets.

-- ============================================================
-- Company: campos de gestão SaaS
-- ============================================================
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "plan"             TEXT NOT NULL DEFAULT 'STARTER';
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "blocked"          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "licenseExpiresAt" TIMESTAMPTZ;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "workerLimit"      INTEGER;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "accessToken"      TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "companies_accessToken_key"
  ON "companies"("accessToken")
  WHERE "accessToken" IS NOT NULL;

-- ============================================================
-- SuperAdmin
-- ============================================================
CREATE TABLE IF NOT EXISTS "super_admins" (
  "id"           TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "totpSecret"   TEXT,
  "totpEnabled"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "super_admins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "super_admins_email_key" ON "super_admins"("email");

-- ============================================================
-- SaContract — contratos de licenciamento
-- ============================================================
CREATE TABLE IF NOT EXISTS "sa_contracts" (
  "id"             TEXT NOT NULL,
  "companyId"      TEXT,
  "tenantName"     TEXT NOT NULL,
  "tenantCnpj"     TEXT,
  "plan"           TEXT NOT NULL,
  "monthlyValue"   DOUBLE PRECISION NOT NULL,
  "contractMonths" INTEGER NOT NULL,
  "startDate"      TIMESTAMPTZ NOT NULL,
  "endDate"        TIMESTAMPTZ NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'DRAFT',
  "signedAt"       TIMESTAMPTZ,
  "clauses"        JSONB NOT NULL DEFAULT '{}',
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sa_contracts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sa_contracts_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "sa_contracts_companyId_idx" ON "sa_contracts"("companyId");

-- ============================================================
-- SaInvoice — faturas
-- ============================================================
CREATE TABLE IF NOT EXISTS "sa_invoices" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT,
  "description" TEXT NOT NULL,
  "amount"      DOUBLE PRECISION NOT NULL,
  "dueDate"     TIMESTAMPTZ NOT NULL,
  "paidAt"      TIMESTAMPTZ,
  "status"      TEXT NOT NULL DEFAULT 'PENDING',
  "notes"       TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sa_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sa_invoices_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "sa_invoices_companyId_idx" ON "sa_invoices"("companyId");
CREATE INDEX IF NOT EXISTS "sa_invoices_status_idx"    ON "sa_invoices"("status");

-- ============================================================
-- SupportTicket — tickets de suporte
-- ============================================================
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id"          TEXT NOT NULL,
  "companyId"   TEXT,
  "authorEmail" TEXT NOT NULL,
  "authorName"  TEXT NOT NULL,
  "subject"     TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'OPEN',
  "priority"    TEXT NOT NULL DEFAULT 'MEDIUM',
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_tickets_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "support_tickets_companyId_idx" ON "support_tickets"("companyId");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx"    ON "support_tickets"("status");

-- ============================================================
-- TicketReply — respostas a tickets
-- ============================================================
CREATE TABLE IF NOT EXISTS "ticket_replies" (
  "id"          TEXT NOT NULL,
  "ticketId"    TEXT NOT NULL,
  "authorEmail" TEXT NOT NULL,
  "authorName"  TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "isInternal"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_replies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ticket_replies_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "ticket_replies_ticketId_idx" ON "ticket_replies"("ticketId");
