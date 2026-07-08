-- ============================================================================
-- Migration: Worker Assignments
-- Separa a identidade pessoal do colaborador (Worker) do seu vínculo com cada
-- obra (WorkerAssignment). Um colaborador pode agora pertencer a N obras com
-- um único crachá, e cada obra rastreia seus próprios requisitos.
-- ============================================================================

-- 1. Criar tabela worker_assignments com os dados de vínculo que saem de workers
CREATE TABLE "worker_assignments" (
    "id"              TEXT            NOT NULL,
    "companyId"       TEXT            NOT NULL,
    "workerId"        TEXT            NOT NULL,
    "obraId"          TEXT            NOT NULL,
    "contractorId"    TEXT            NOT NULL,
    "functionId"      TEXT,
    "role"            TEXT            NOT NULL DEFAULT '',
    "registration"    TEXT,
    "admissionDate"   TIMESTAMP(3),
    "shiftStart"      TEXT,
    "shiftEnd"        TEXT,
    "status"          "WorkerStatus"  NOT NULL DEFAULT 'ACTIVE',
    "accessValidUntil" TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "worker_assignments_pkey" PRIMARY KEY ("id")
);

-- 2. Migrar dados: cada worker existente vira um WorkerAssignment
INSERT INTO "worker_assignments"
    ("id", "companyId", "workerId", "obraId", "contractorId", "functionId",
     "role", "registration", "admissionDate", "shiftStart", "shiftEnd",
     "status", "accessValidUntil", "createdAt", "updatedAt")
SELECT
    -- Gera ID único para cada assignment
    encode(sha256((w."id" || '-assignment')::bytea), 'hex'),
    w."companyId",
    w."id",
    w."obraId",
    w."contractorId",
    w."functionId",
    w."role",
    w."registration",
    w."admissionDate",
    w."shiftStart",
    w."shiftEnd",
    w."status",
    w."accessValidUntil",
    w."createdAt",
    w."updatedAt"
FROM "workers" w;

-- 3. Adicionar assignmentId em worker_requirement_items (nullable para migração segura)
ALTER TABLE "worker_requirement_items" ADD COLUMN "assignmentId" TEXT;

-- 4. Preencher assignmentId a partir do assignment criado para cada worker
UPDATE "worker_requirement_items" wri
SET "assignmentId" = wa."id"
FROM "worker_assignments" wa
WHERE wa."workerId" = wri."workerId";

-- 5. Adicionar foreign keys em worker_assignments
ALTER TABLE "worker_assignments"
    ADD CONSTRAINT "worker_assignments_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "worker_assignments"
    ADD CONSTRAINT "worker_assignments_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "worker_assignments"
    ADD CONSTRAINT "worker_assignments_obraId_fkey"
    FOREIGN KEY ("obraId") REFERENCES "obras"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "worker_assignments"
    ADD CONSTRAINT "worker_assignments_contractorId_fkey"
    FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worker_assignments"
    ADD CONSTRAINT "worker_assignments_functionId_fkey"
    FOREIGN KEY ("functionId") REFERENCES "worker_functions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Adicionar FK de assignmentId em worker_requirement_items
ALTER TABLE "worker_requirement_items"
    ADD CONSTRAINT "worker_requirement_items_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "worker_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Criar índices em worker_assignments
CREATE UNIQUE INDEX "worker_assignments_obraId_workerId_key" ON "worker_assignments"("obraId", "workerId");
CREATE INDEX "worker_assignments_workerId_idx" ON "worker_assignments"("workerId");
CREATE INDEX "worker_assignments_obraId_idx" ON "worker_assignments"("obraId");
CREATE INDEX "worker_assignments_contractorId_idx" ON "worker_assignments"("contractorId");
CREATE INDEX "worker_assignments_companyId_status_idx" ON "worker_assignments"("companyId", "status");

-- Índice no novo campo
CREATE INDEX "worker_requirement_items_assignmentId_idx" ON "worker_requirement_items"("assignmentId");

-- 8. Remover unique antigo (obraId, cpf) e criar novo (companyId, cpf)
DROP INDEX "workers_obraId_cpf_key";
CREATE UNIQUE INDEX "workers_companyId_cpf_key" ON "workers"("companyId", "cpf");

-- 9. Remover colunas de vínculo de workers (agora vivem em worker_assignments)
ALTER TABLE "workers" DROP COLUMN "obraId";
ALTER TABLE "workers" DROP COLUMN "contractorId";
ALTER TABLE "workers" DROP COLUMN "functionId";
ALTER TABLE "workers" DROP COLUMN "role";
ALTER TABLE "workers" DROP COLUMN "registration";
ALTER TABLE "workers" DROP COLUMN "admissionDate";
ALTER TABLE "workers" DROP COLUMN "shiftStart";
ALTER TABLE "workers" DROP COLUMN "shiftEnd";
ALTER TABLE "workers" DROP COLUMN "status";
ALTER TABLE "workers" DROP COLUMN "accessValidUntil";

-- 10. Remover índices antigos que referenciavam colunas removidas
DROP INDEX IF EXISTS "workers_contractorId_idx";
DROP INDEX IF EXISTS "workers_obraId_idx";
DROP INDEX IF EXISTS "workers_functionId_idx";
DROP INDEX IF EXISTS "workers_companyId_status_idx";
