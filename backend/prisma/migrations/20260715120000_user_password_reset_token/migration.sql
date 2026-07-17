-- Migration: token de redefinição de senha ("esqueci minha senha").

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "resetPasswordToken"          TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "resetPasswordTokenExpiresAt" TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS "users_resetPasswordToken_key"
  ON "users"("resetPasswordToken")
  WHERE "resetPasswordToken" IS NOT NULL;
