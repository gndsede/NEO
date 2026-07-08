-- CreateEnum
CREATE TYPE "CompetenceMode" AS ENUM ('NONE', 'ALLOWED', 'REQUIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RequirementFrequency" ADD VALUE 'BY_EXPIRY';
ALTER TYPE "RequirementFrequency" ADD VALUE 'DAILY';
ALTER TYPE "RequirementFrequency" ADD VALUE 'WEEKLY';
ALTER TYPE "RequirementFrequency" ADD VALUE 'BIWEEKLY';
ALTER TYPE "RequirementFrequency" ADD VALUE 'BIMONTHLY';
ALTER TYPE "RequirementFrequency" ADD VALUE 'QUARTERLY';
ALTER TYPE "RequirementFrequency" ADD VALUE 'FOUR_MONTHLY';
ALTER TYPE "RequirementFrequency" ADD VALUE 'SEMIANNUAL';
ALTER TYPE "RequirementFrequency" ADD VALUE 'ANNUAL';

-- DropIndex
DROP INDEX "rdos_approvedById_idx";

-- AlterTable
ALTER TABLE "document_requirement_definitions" ADD COLUMN     "attachmentFormats" TEXT,
ADD COLUMN     "attachmentRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "competenceMode" "CompetenceMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "grantsTurnstileAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "observations" TEXT;

-- CreateTable
CREATE TABLE "user_groups" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_definition_group_access" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_definition_group_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_definition_user_access" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_definition_user_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_groups_companyId_active_idx" ON "user_groups"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "user_groups_companyId_name_key" ON "user_groups"("companyId", "name");

-- CreateIndex
CREATE INDEX "user_group_members_userId_idx" ON "user_group_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_members_groupId_userId_key" ON "user_group_members"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_definition_group_access_requirementId_groupId_key" ON "requirement_definition_group_access"("requirementId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_definition_user_access_requirementId_userId_key" ON "requirement_definition_user_access"("requirementId", "userId");

-- AddForeignKey
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_definition_group_access" ADD CONSTRAINT "requirement_definition_group_access_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "document_requirement_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_definition_group_access" ADD CONSTRAINT "requirement_definition_group_access_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_definition_user_access" ADD CONSTRAINT "requirement_definition_user_access_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "document_requirement_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_definition_user_access" ADD CONSTRAINT "requirement_definition_user_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
