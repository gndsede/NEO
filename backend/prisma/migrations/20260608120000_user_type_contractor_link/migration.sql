-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('COMPANY', 'SUPPLIER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "userType" "UserType" NOT NULL DEFAULT 'COMPANY';
ALTER TABLE "users" ADD COLUMN "contractorId" TEXT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
