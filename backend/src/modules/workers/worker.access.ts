import { DocumentStatus, WorkerStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Recalcula a validade de acesso de um colaborador a partir da documentação.
 *
 * Regra (MVP, ajustável conforme política de SST do cliente):
 * - `accessValidUntil` = menor data de validade entre documentos APROVADOS
 *   que possuem `expiresAt` (o documento que vence primeiro limita o acesso).
 * - Se houver qualquer documento REJEITADO, o colaborador fica BLOCKED.
 * - Caso contrário, ACTIVE.
 */
export async function recomputeWorkerAccessValidity(
  workerId: string,
): Promise<void> {
  const docs = await prisma.document.findMany({
    where: { workerId },
    select: { status: true, expiresAt: true },
  });

  const hasRejected = docs.some(
    (d) => d.status === DocumentStatus.REJEITADO,
  );

  const approvedExpirations = docs
    .filter((d) => d.status === DocumentStatus.APROVADO && d.expiresAt)
    .map((d) => d.expiresAt as Date);

  const accessValidUntil =
    approvedExpirations.length > 0
      ? new Date(Math.min(...approvedExpirations.map((d) => d.getTime())))
      : null;

  await prisma.worker.update({
    where: { id: workerId },
    data: {
      accessValidUntil,
      status: hasRejected ? WorkerStatus.BLOCKED : WorkerStatus.ACTIVE,
    },
  });
}
