-- Novo perfil: apenas USER e COLLABORATOR
CREATE TYPE "UserProfile" AS ENUM ('USER', 'COLLABORATOR');

ALTER TABLE "users" ADD COLUMN "profile" "UserProfile";

UPDATE "users"
SET "profile" = CASE
  WHEN "userType" = 'SUPPLIER' THEN 'COLLABORATOR'::"UserProfile"
  ELSE 'USER'::"UserProfile"
END;

ALTER TABLE "users" ALTER COLUMN "profile" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "profile" SET DEFAULT 'USER';

-- Concede todas as permissões (lista vazia será normalizada no app) aos antigos OWNER/ADMIN via JSON array
UPDATE "users"
SET "permissions" = '["dashboard.view","obras.view","obras.manage","registros.view","registros.manage","tipos.view","tipos.manage","documentos.view","documentos.attach","documentos.approve","documentos.mark_na","colaboradores.view","colaboradores.manage","fornecedores.view","fornecedores.manage","cracha.view","cracha.generate","catraca.view","catraca.manage","usuarios.view","usuarios.manage"]'::jsonb
WHERE "role" IN ('OWNER', 'ADMIN');

UPDATE "users"
SET "permissions" = '["dashboard.view","documentos.view","documentos.attach","documentos.approve","documentos.mark_na","colaboradores.view","fornecedores.view"]'::jsonb
WHERE "role" = 'APPROVER' AND ("permissions" IS NULL OR "permissions"::text = '{}');

ALTER TABLE "users" DROP COLUMN "role";
ALTER TABLE "users" DROP COLUMN "userType";

DROP TYPE "UserRole";
DROP TYPE "UserType";
