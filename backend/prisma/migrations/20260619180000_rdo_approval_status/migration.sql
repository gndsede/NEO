-- Rename old enum values by recreating the type
-- (table is empty — safe to do without USING conversion)

-- 1. Remove default so we can alter the column type
ALTER TABLE "rdos" ALTER COLUMN "status" DROP DEFAULT;

-- 2. Create new enum with the desired values
CREATE TYPE "RdoStatus_new" AS ENUM ('PENDENTE', 'AGUARDANDO_APROVACAO', 'APROVADO', 'REPROVADO');

-- 3. Cast column to new type (table is empty, no rows to convert)
ALTER TABLE "rdos"
  ALTER COLUMN "status" TYPE "RdoStatus_new"
  USING "status"::text::"RdoStatus_new";

-- 4. Drop old type and rename new
DROP TYPE "RdoStatus";
ALTER TYPE "RdoStatus_new" RENAME TO "RdoStatus";

-- 5. Restore default using new enum value
ALTER TABLE "rdos" ALTER COLUMN "status" SET DEFAULT 'PENDENTE'::"RdoStatus";

-- 6. Add approval fields
ALTER TABLE "rdos" ADD COLUMN "approvedById"    TEXT;
ALTER TABLE "rdos" ADD COLUMN "approvedAt"      TIMESTAMP(3);
ALTER TABLE "rdos" ADD COLUMN "rejectionReason" TEXT;

-- 7. Foreign key for approvedById → users
ALTER TABLE "rdos"
  ADD CONSTRAINT "rdos_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 8. Index for approved-by queries
CREATE INDEX "rdos_approvedById_idx" ON "rdos"("approvedById");
