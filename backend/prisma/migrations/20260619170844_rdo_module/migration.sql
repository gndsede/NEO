-- CreateEnum
CREATE TYPE "RdoStatus" AS ENUM ('RASCUNHO', 'FINALIZADO');

-- CreateTable
CREATE TABLE "rdos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "obraId" TEXT,
    "contratoNumero" TEXT,
    "docNumero" TEXT,
    "data" TIMESTAMP(3) NOT NULL,
    "turnos" TEXT,
    "jornadaTrabalho" TEXT,
    "localidade" TEXT,
    "dataInicio" TIMESTAMP(3),
    "dataTermino" TIMESTAMP(3),
    "diasDecorridos" INTEGER,
    "diasRestantes" INTEGER,
    "diasAtraso" INTEGER,
    "prorrogacao" TIMESTAMP(3),
    "climaManha" TEXT,
    "climaTarde" TEXT,
    "climaNoite" TEXT,
    "chuvaQuantMm" DOUBLE PRECISION,
    "efetivoIndireta" JSONB NOT NULL DEFAULT '[]',
    "efetivoODireta" JSONB NOT NULL DEFAULT '[]',
    "equipamentos" JSONB NOT NULL DEFAULT '[]',
    "atividades" JSONB NOT NULL DEFAULT '[]',
    "materiais" JSONB NOT NULL DEFAULT '[]',
    "consideracoesContratada" TEXT,
    "consideracoesFiscalizacao" TEXT,
    "fotos" JSONB NOT NULL DEFAULT '[]',
    "arquivos" JSONB NOT NULL DEFAULT '[]',
    "status" "RdoStatus" NOT NULL DEFAULT 'RASCUNHO',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rdos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rdos_companyId_data_idx" ON "rdos"("companyId", "data");

-- CreateIndex
CREATE INDEX "rdos_companyId_status_idx" ON "rdos"("companyId", "status");

-- CreateIndex
CREATE INDEX "rdos_obraId_idx" ON "rdos"("obraId");

-- AddForeignKey
ALTER TABLE "rdos" ADD CONSTRAINT "rdos_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rdos" ADD CONSTRAINT "rdos_obraId_fkey" FOREIGN KEY ("obraId") REFERENCES "obras"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rdos" ADD CONSTRAINT "rdos_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
