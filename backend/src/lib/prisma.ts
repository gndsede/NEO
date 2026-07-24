import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env.js";
import { dbMetrics } from "./db-metrics.js";

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  // Preserva timeouts próximos aos defaults do Prisma v6.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 300_000,
});

function createPrismaClient() {
  return new PrismaClient({
    adapter,
    // Eventos (não stdout) em todos os ambientes: alimenta db-metrics para o
    // painel de observabilidade (query timing + amostra de queries lentas).
    log: [
      { emit: "event", level: "query" },
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  });
}

/**
 * Singleton do PrismaClient (Prisma 7 com driver adapter node-postgres).
 * Evita esgotar o pool de conexões em hot-reload (tsx watch / nodemon).
 */
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

prisma.$on("query", (e: Prisma.QueryEvent) => {
  dbMetrics.record(e);
});

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
