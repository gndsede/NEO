-- Reduz o enum "DocumentType" de 9 valores para apenas 2: SAFETY (documento
-- de segurança do trabalho) e STANDARD (documento padrão/administrativo).
-- Mapeamento dos valores antigos:
--   SAFETY:   ASO, NR_35, NR_10, NR_18, EPI
--   STANDARD: RG_CPF, CONTRATO, CNPJ, OUTRO
-- Os dados existentes são preservados/remapeados (não apagados).

CREATE TYPE "DocumentType_new" AS ENUM ('SAFETY', 'STANDARD');

ALTER TABLE "document_requirement_definitions"
  ALTER COLUMN "documentType" TYPE "DocumentType_new"
  USING (
    CASE "documentType"::text
      WHEN 'ASO' THEN 'SAFETY'
      WHEN 'NR_35' THEN 'SAFETY'
      WHEN 'NR_10' THEN 'SAFETY'
      WHEN 'NR_18' THEN 'SAFETY'
      WHEN 'EPI' THEN 'SAFETY'
      ELSE 'STANDARD'
    END
  )::"DocumentType_new";

ALTER TABLE "worker_requirement_items"
  ALTER COLUMN "documentType" TYPE "DocumentType_new"
  USING (
    CASE "documentType"::text
      WHEN 'ASO' THEN 'SAFETY'
      WHEN 'NR_35' THEN 'SAFETY'
      WHEN 'NR_10' THEN 'SAFETY'
      WHEN 'NR_18' THEN 'SAFETY'
      WHEN 'EPI' THEN 'SAFETY'
      ELSE 'STANDARD'
    END
  )::"DocumentType_new";

ALTER TABLE "contractor_requirement_items"
  ALTER COLUMN "documentType" TYPE "DocumentType_new"
  USING (
    CASE "documentType"::text
      WHEN 'ASO' THEN 'SAFETY'
      WHEN 'NR_35' THEN 'SAFETY'
      WHEN 'NR_10' THEN 'SAFETY'
      WHEN 'NR_18' THEN 'SAFETY'
      WHEN 'EPI' THEN 'SAFETY'
      ELSE 'STANDARD'
    END
  )::"DocumentType_new";

ALTER TABLE "documents"
  ALTER COLUMN "type" TYPE "DocumentType_new"
  USING (
    CASE "type"::text
      WHEN 'ASO' THEN 'SAFETY'
      WHEN 'NR_35' THEN 'SAFETY'
      WHEN 'NR_10' THEN 'SAFETY'
      WHEN 'NR_18' THEN 'SAFETY'
      WHEN 'EPI' THEN 'SAFETY'
      ELSE 'STANDARD'
    END
  )::"DocumentType_new";

DROP TYPE "DocumentType";
ALTER TYPE "DocumentType_new" RENAME TO "DocumentType";
