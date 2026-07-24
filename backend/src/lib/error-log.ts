import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export interface ErrorLogEntry {
  requestId?: string | null;
  method: string;
  path: string;
  statusCode: number;
  message: string;
  stack?: string | null;
  companyId?: string | null;
  actorId?: string | null;
  meta?: Record<string, unknown> | null;
}

/**
 * Persiste um erro de requisição para consulta no painel de observabilidade
 * do super-admin. Best-effort: uma falha ao gravar NUNCA derruba a resposta
 * de erro já em andamento (mesmo princípio de `lib/audit.ts`).
 */
export async function recordError(entry: ErrorLogEntry): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: {
        requestId: entry.requestId ?? null,
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        message: entry.message,
        stack: entry.stack ?? null,
        companyId: entry.companyId ?? null,
        actorId: entry.actorId ?? null,
        meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[error-log] falha ao gravar ErrorLog:", err);
  }
}
