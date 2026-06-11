-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'APPROVER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DocumentOwnerType" AS ENUM ('WORKER', 'CONTRACTOR');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('ASO', 'NR_35', 'NR_10', 'NR_18', 'EPI', 'RG_CPF', 'CONTRATO', 'CNPJ', 'OUTRO');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDENTE', 'APROVADO', 'REJEITADO');

-- CreateEnum
CREATE TYPE "RequirementFrequency" AS ENUM ('MONTHLY', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "RequirementTarget" AS ENUM ('WORKER', 'CONTRACTOR');

-- CreateEnum
CREATE TYPE "RequirementSource" AS ENUM ('FUNCTION_TEMPLATE', 'CONTRACTOR_TYPE_TEMPLATE', 'MANUAL');

-- CreateEnum
CREATE TYPE "RequirementCollectionStatus" AS ENUM ('NOT_SENT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "AccessDirection" AS ENUM ('ENTRY', 'EXIT');

-- CreateEnum
CREATE TYPE "AccessResult" AS ENUM ('GRANTED', 'DENIED');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "document" TEXT,
    "siteName" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "state" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OPERATOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractors" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "typeId" TEXT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "cnpj" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "functionId" TEXT,
    "fullName" TEXT NOT NULL,
    "cpf" TEXT NOT NULL,
    "rg" TEXT,
    "birthDate" TIMESTAMP(3),
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT NOT NULL,
    "registration" TEXT,
    "photoUrl" TEXT,
    "qrHash" TEXT NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessValidUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_requirement_definitions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "target" "RequirementTarget" NOT NULL,
    "name" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "frequency" "RequirementFrequency" NOT NULL,
    "monthlyDueDay" INTEGER,
    "referenceDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_requirement_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_functions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_functions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_function_requirements" (
    "id" TEXT NOT NULL,
    "functionId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "worker_function_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_types" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_type_requirements" (
    "id" TEXT NOT NULL,
    "contractorTypeId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "contractor_type_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_requirement_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "requirementId" TEXT,
    "source" "RequirementSource" NOT NULL,
    "status" "RequirementCollectionStatus" NOT NULL DEFAULT 'NOT_SENT',
    "naReason" TEXT,
    "name" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "frequency" "RequirementFrequency" NOT NULL,
    "monthlyDueDay" INTEGER,
    "referenceDate" TIMESTAMP(3),
    "latestDocumentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_requirement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contractor_requirement_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "requirementId" TEXT,
    "source" "RequirementSource" NOT NULL,
    "status" "RequirementCollectionStatus" NOT NULL DEFAULT 'NOT_SENT',
    "naReason" TEXT,
    "name" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "frequency" "RequirementFrequency" NOT NULL,
    "monthlyDueDay" INTEGER,
    "referenceDate" TIMESTAMP(3),
    "latestDocumentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contractor_requirement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ownerType" "DocumentOwnerType" NOT NULL,
    "workerId" TEXT,
    "contractorId" TEXT,
    "workerRequirementItemId" TEXT,
    "contractorRequirementItemId" TEXT,
    "type" "DocumentType" NOT NULL,
    "title" TEXT,
    "fileUrl" TEXT NOT NULL,
    "fileKey" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDENTE',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT,
    "direction" "AccessDirection" NOT NULL,
    "result" "AccessResult" NOT NULL DEFAULT 'GRANTED',
    "reason" TEXT,
    "gate" TEXT,
    "qrHash" TEXT,
    "operatorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_document_key" ON "companies"("document");

-- CreateIndex
CREATE INDEX "companies_active_idx" ON "companies"("active");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_companyId_idx" ON "users"("companyId");

-- CreateIndex
CREATE INDEX "contractors_companyId_idx" ON "contractors"("companyId");

-- CreateIndex
CREATE INDEX "contractors_typeId_idx" ON "contractors"("typeId");

-- CreateIndex
CREATE UNIQUE INDEX "contractors_companyId_cnpj_key" ON "contractors"("companyId", "cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "workers_qrHash_key" ON "workers"("qrHash");

-- CreateIndex
CREATE INDEX "workers_contractorId_idx" ON "workers"("contractorId");

-- CreateIndex
CREATE INDEX "workers_functionId_idx" ON "workers"("functionId");

-- CreateIndex
CREATE INDEX "workers_companyId_status_idx" ON "workers"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workers_companyId_cpf_key" ON "workers"("companyId", "cpf");

-- CreateIndex
CREATE INDEX "document_requirement_definitions_companyId_target_active_idx" ON "document_requirement_definitions"("companyId", "target", "active");

-- CreateIndex
CREATE INDEX "document_requirement_definitions_companyId_documentType_idx" ON "document_requirement_definitions"("companyId", "documentType");

-- CreateIndex
CREATE INDEX "worker_functions_companyId_active_idx" ON "worker_functions"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "worker_functions_companyId_name_key" ON "worker_functions"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "worker_function_requirements_functionId_requirementId_key" ON "worker_function_requirements"("functionId", "requirementId");

-- CreateIndex
CREATE INDEX "contractor_types_companyId_active_idx" ON "contractor_types"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "contractor_types_companyId_name_key" ON "contractor_types"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "contractor_type_requirements_contractorTypeId_requirementId_key" ON "contractor_type_requirements"("contractorTypeId", "requirementId");

-- CreateIndex
CREATE INDEX "worker_requirement_items_companyId_workerId_status_idx" ON "worker_requirement_items"("companyId", "workerId", "status");

-- CreateIndex
CREATE INDEX "worker_requirement_items_requirementId_idx" ON "worker_requirement_items"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "worker_requirement_items_latestDocumentId_key" ON "worker_requirement_items"("latestDocumentId");

-- CreateIndex
CREATE INDEX "contractor_requirement_items_companyId_contractorId_status_idx" ON "contractor_requirement_items"("companyId", "contractorId", "status");

-- CreateIndex
CREATE INDEX "contractor_requirement_items_requirementId_idx" ON "contractor_requirement_items"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "contractor_requirement_items_latestDocumentId_key" ON "contractor_requirement_items"("latestDocumentId");

-- CreateIndex
CREATE INDEX "documents_companyId_status_idx" ON "documents"("companyId", "status");

-- CreateIndex
CREATE INDEX "documents_workerId_idx" ON "documents"("workerId");

-- CreateIndex
CREATE INDEX "documents_contractorId_idx" ON "documents"("contractorId");

-- CreateIndex
CREATE INDEX "documents_workerRequirementItemId_idx" ON "documents"("workerRequirementItemId");

-- CreateIndex
CREATE INDEX "documents_contractorRequirementItemId_idx" ON "documents"("contractorRequirementItemId");

-- CreateIndex
CREATE INDEX "documents_ownerType_status_idx" ON "documents"("ownerType", "status");

-- CreateIndex
CREATE INDEX "documents_expiresAt_idx" ON "documents"("expiresAt");

-- CreateIndex
CREATE INDEX "access_logs_companyId_occurredAt_idx" ON "access_logs"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "access_logs_workerId_occurredAt_idx" ON "access_logs"("workerId", "occurredAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "contractor_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workers" ADD CONSTRAINT "workers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workers" ADD CONSTRAINT "workers_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workers" ADD CONSTRAINT "workers_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "worker_functions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requirement_definitions" ADD CONSTRAINT "document_requirement_definitions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_functions" ADD CONSTRAINT "worker_functions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_function_requirements" ADD CONSTRAINT "worker_function_requirements_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "worker_functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_function_requirements" ADD CONSTRAINT "worker_function_requirements_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "document_requirement_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_types" ADD CONSTRAINT "contractor_types_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_type_requirements" ADD CONSTRAINT "contractor_type_requirements_contractorTypeId_fkey" FOREIGN KEY ("contractorTypeId") REFERENCES "contractor_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_type_requirements" ADD CONSTRAINT "contractor_type_requirements_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "document_requirement_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_requirement_items" ADD CONSTRAINT "worker_requirement_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_requirement_items" ADD CONSTRAINT "worker_requirement_items_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_requirement_items" ADD CONSTRAINT "worker_requirement_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "document_requirement_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_requirement_items" ADD CONSTRAINT "worker_requirement_items_latestDocumentId_fkey" FOREIGN KEY ("latestDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_requirement_items" ADD CONSTRAINT "worker_requirement_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_requirement_items" ADD CONSTRAINT "contractor_requirement_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_requirement_items" ADD CONSTRAINT "contractor_requirement_items_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_requirement_items" ADD CONSTRAINT "contractor_requirement_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "document_requirement_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_requirement_items" ADD CONSTRAINT "contractor_requirement_items_latestDocumentId_fkey" FOREIGN KEY ("latestDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contractor_requirement_items" ADD CONSTRAINT "contractor_requirement_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_workerRequirementItemId_fkey" FOREIGN KEY ("workerRequirementItemId") REFERENCES "worker_requirement_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_contractorRequirementItemId_fkey" FOREIGN KEY ("contractorRequirementItemId") REFERENCES "contractor_requirement_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
