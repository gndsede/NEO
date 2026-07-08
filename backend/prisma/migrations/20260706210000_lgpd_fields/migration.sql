-- LGPD: adiciona cpfHash (índice único por HMAC/SHA256 do CPF) e anonymizedAt.
-- cpfHash substitui o unique composto (companyId, cpf) para permitir que o CPF seja
-- criptografado (AES-256-GCM) sem perder a capacidade de verificar unicidade.

-- Adiciona as novas colunas como nullable para preenchimento
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "cpfHash"      TEXT;
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "anonymizedAt" TIMESTAMPTZ;

-- Popula cpfHash para todos os workers existentes usando SHA256 puro do CPF normalizado.
-- (Quando a ENCRYPTION_KEY for ativada, execute o script scripts/encrypt-pii.ts para
--  recomputar cpfHash como HMAC e criptografar o campo cpf.)
UPDATE "workers"
SET "cpfHash" = encode(sha256(regexp_replace(lower("cpf"), '\D', '', 'g')::bytea), 'hex')
WHERE "cpfHash" IS NULL;

-- Torna cpfHash obrigatório agora que todos os registros estão preenchidos
ALTER TABLE "workers" ALTER COLUMN "cpfHash" SET NOT NULL;

-- Cria índice único (companyId, cpfHash) — substitui (companyId, cpf)
ALTER TABLE "workers"
  ADD CONSTRAINT "workers_companyId_cpfHash_key" UNIQUE ("companyId", "cpfHash");

-- Remove o índice único antigo baseado em texto plano do CPF
ALTER TABLE "workers"
  DROP CONSTRAINT IF EXISTS "workers_companyId_cpf_key";
