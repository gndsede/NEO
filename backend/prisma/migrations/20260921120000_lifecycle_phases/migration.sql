-- Fases do ciclo de vida documental: ENTRADA -> ATIVIDADE -> SAIDA.

CREATE TYPE "LifecyclePhase" AS ENUM ('ENTRADA', 'ATIVIDADE', 'SAIDA');

-- Registros documentais: em que fase(s) cada exigência é cobrada.
-- Todo registro já existente passa a ser cobrado em ATIVIDADE (comportamento atual).
ALTER TABLE "document_requirement_definitions"
  ADD COLUMN "phases" "LifecyclePhase"[] NOT NULL DEFAULT ARRAY['ATIVIDADE']::"LifecyclePhase"[];

-- Itens de coleta já materializados pertencem à fase de atividade.
ALTER TABLE "worker_requirement_items"
  ADD COLUMN "phase" "LifecyclePhase" NOT NULL DEFAULT 'ATIVIDADE';

-- Vínculos: novos nascem em ENTRADA, mas os que já existem estão em operação.
-- Adiciona com default ATIVIDADE para backfill e só então troca o default.
ALTER TABLE "worker_assignments"
  ADD COLUMN "phase" "LifecyclePhase" NOT NULL DEFAULT 'ATIVIDADE',
  ADD COLUMN "phaseUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "worker_assignments"
  ALTER COLUMN "phase" SET DEFAULT 'ENTRADA';

CREATE INDEX "worker_assignments_companyId_phase_idx"
  ON "worker_assignments"("companyId", "phase");

CREATE INDEX "worker_requirement_items_assignmentId_phase_status_idx"
  ON "worker_requirement_items"("assignmentId", "phase", "status");
