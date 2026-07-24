import { prisma } from "./prisma.js";

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Checa conectividade com o Postgres e mede a latência de um SELECT trivial. */
export async function checkDatabase(): Promise<DbHealth> {
  const startedAt = process.hrtime.bigint();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      ok: true,
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
