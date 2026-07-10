-- Migration: token de convite para definição de senha no primeiro acesso
-- (usado quando o super-admin cria um tenant e convida o administrador por e-mail).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "inviteToken"          TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "inviteTokenExpiresAt" TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS "users_inviteToken_key"
  ON "users"("inviteToken")
  WHERE "inviteToken" IS NOT NULL;
