-- CreateEnum
CREATE TYPE "LaborType" AS ENUM ('DIRETA', 'INDIRETA');

-- AlterTable: mão de obra direta/indireta por vínculo (obra)
ALTER TABLE "worker_assignments" ADD COLUMN     "laborType" "LaborType" NOT NULL DEFAULT 'DIRETA';

-- AlterTable: tipos de documento visíveis para membros do grupo (vazio = sem restrição)
ALTER TABLE "user_groups" ADD COLUMN     "visibleDocumentTypes" "DocumentType"[] DEFAULT ARRAY[]::"DocumentType"[];

-- AlterTable: acesso explícito a todas as obras, independente da permissão obras.manage
ALTER TABLE "users" ADD COLUMN     "allObrasAccess" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: preserva o comportamento atual para quem já tinha a permissão
-- "obras.manage" (que hoje implicitamente concede acesso a todas as obras).
UPDATE "users"
SET "allObrasAccess" = true
WHERE "permissions"::jsonb @> '["obras.manage"]'::jsonb;
