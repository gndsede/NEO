import { AccessDirection, AccessResult } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Decide automaticamente a direção do próximo scan de um colaborador.
 *
 * Regra: olha o último log GRANTED desse worker (qualquer dia).
 *   - Nenhum log → ENTRY
 *   - Último foi EXIT → ENTRY
 *   - Último foi ENTRY → EXIT
 *
 * Assim, escaneamentos consecutivos viram ENTRY/EXIT alternados, e o cron
 * de auto-EXIT 8h fecha entradas órfãs sem precisar de intervenção manual.
 */
export async function resolveNextDirection(params: {
  companyId: string;
  workerId: string;
}): Promise<AccessDirection> {
  const last = await prisma.accessLog.findFirst({
    where: {
      companyId: params.companyId,
      workerId: params.workerId,
      result: AccessResult.GRANTED,
    },
    orderBy: { occurredAt: "desc" },
    select: { direction: true },
  });

  if (!last) return AccessDirection.ENTRY;
  return last.direction === AccessDirection.ENTRY
    ? AccessDirection.EXIT
    : AccessDirection.ENTRY;
}
