-- CreateEnum
CREATE TYPE "RequirementStage" AS ENUM ('NONE', 'AWAITING_UPLOAD', 'AWAITING_SIGNATURE', 'AWAITING_REVIEW');

-- CreateEnum
CREATE TYPE "EffectiveRequirementStatus" AS ENUM ('EM_FALTA', 'AGUARDANDO', 'REPROVADO', 'VIGENTE', 'PROX_VENCIMENTO', 'VENCIDO', 'NA');

-- AlterTable
ALTER TABLE "worker_requirement_items" ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "effectiveStatus" "EffectiveRequirementStatus" NOT NULL DEFAULT 'EM_FALTA',
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "stage" "RequirementStage" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "worker_requirement_items_companyId_effectiveStatus_idx" ON "worker_requirement_items"("companyId", "effectiveStatus");

-- CreateIndex
CREATE INDEX "worker_requirement_items_companyId_dueDate_idx" ON "worker_requirement_items"("companyId", "dueDate");

-- CreateIndex
CREATE INDEX "worker_requirement_items_workerId_effectiveStatus_idx" ON "worker_requirement_items"("workerId", "effectiveStatus");
