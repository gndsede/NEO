-- AlterTable: permissões concedidas aos membros do grupo (somam-se às individuais)
ALTER TABLE "user_groups" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
