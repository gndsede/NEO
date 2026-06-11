-- CreateTable
CREATE TABLE "obras" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "state" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "obras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_obra_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "obraId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_obra_access_pkey" PRIMARY KEY ("id")
);

-- Add obraId columns (nullable for backfill)
ALTER TABLE "contractors" ADD COLUMN "obraId" TEXT;
ALTER TABLE "workers" ADD COLUMN "obraId" TEXT;

-- Default obra per company from existing siteName / company name
INSERT INTO "obras" ("id", "companyId", "name", "code", "addressLine", "city", "state", "active", "createdAt", "updatedAt")
SELECT
    'obra_' || "id",
    "id",
    COALESCE(NULLIF("siteName", ''), "name"),
    'principal',
    "addressLine",
    "city",
    "state",
    "active",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "companies";

UPDATE "contractors" c
SET "obraId" = o."id"
FROM "obras" o
WHERE o."companyId" = c."companyId" AND c."obraId" IS NULL;

UPDATE "workers" w
SET "obraId" = o."id"
FROM "obras" o
WHERE o."companyId" = w."companyId" AND w."obraId" IS NULL;

ALTER TABLE "contractors" ALTER COLUMN "obraId" SET NOT NULL;
ALTER TABLE "workers" ALTER COLUMN "obraId" SET NOT NULL;

-- Drop old uniques
DROP INDEX IF EXISTS "contractors_companyId_cnpj_key";
DROP INDEX IF EXISTS "workers_companyId_cpf_key";

-- CreateIndex
CREATE INDEX "obras_companyId_active_idx" ON "obras"("companyId", "active");
CREATE UNIQUE INDEX "obras_companyId_code_key" ON "obras"("companyId", "code");
CREATE INDEX "user_obra_access_obraId_idx" ON "user_obra_access"("obraId");
CREATE UNIQUE INDEX "user_obra_access_userId_obraId_key" ON "user_obra_access"("userId", "obraId");

-- Grant all users access to their company default obra
INSERT INTO "user_obra_access" ("id", "userId", "obraId", "createdAt")
SELECT
    'uoa_' || u."id" || '_' || o."id",
    u."id",
    o."id",
    CURRENT_TIMESTAMP
FROM "users" u
JOIN "obras" o ON o."companyId" = u."companyId" AND o."code" = 'principal'
ON CONFLICT ("userId", "obraId") DO NOTHING;
CREATE INDEX "contractors_obraId_idx" ON "contractors"("obraId");
CREATE UNIQUE INDEX "contractors_obraId_cnpj_key" ON "contractors"("obraId", "cnpj");
CREATE INDEX "workers_obraId_idx" ON "workers"("obraId");
CREATE UNIQUE INDEX "workers_obraId_cpf_key" ON "workers"("obraId", "cpf");
CREATE INDEX "users_contractorId_idx" ON "users"("contractorId");

-- AddForeignKey
ALTER TABLE "obras" ADD CONSTRAINT "obras_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_obra_access" ADD CONSTRAINT "user_obra_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_obra_access" ADD CONSTRAINT "user_obra_access_obraId_fkey" FOREIGN KEY ("obraId") REFERENCES "obras"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_obraId_fkey" FOREIGN KEY ("obraId") REFERENCES "obras"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workers" ADD CONSTRAINT "workers_obraId_fkey" FOREIGN KEY ("obraId") REFERENCES "obras"("id") ON DELETE CASCADE ON UPDATE CASCADE;
