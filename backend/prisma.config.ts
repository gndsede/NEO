import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Configuração do Prisma CLI (Prisma 7).
 * A connection string vive aqui (e não mais no schema). É usada pelo CLI
 * para migrações; o runtime usa o driver adapter (@prisma/adapter-pg).
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
