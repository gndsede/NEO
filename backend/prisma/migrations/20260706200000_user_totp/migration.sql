-- AlterTable: adiciona campos TOTP para autenticação de dois fatores
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpSecret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
