import { DocumentStatus, WorkerStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Recalcula a validade de acesso de um colaborador a partir da documentação.
 *
 * Documentos são compartilhados entre obras (pertencem ao Worker), então
 * `accessValidUntil` e o bloqueio por rejeição se aplicam a todos os vínculos
 * ativos do colaborador (WorkerAssignment).
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

  // Atualiza todos os vínculos não-inativos com o novo accessValidUntil.
  // Se há documento rejeitado, bloqueia os ativos; senão, desbloqueia os que
  // estavam bloqueados por documentação (reativa para ACTIVE).
  await prisma.workerAssignment.updateMany({
    where: { workerId, status: { not: WorkerStatus.INACTIVE } },
    data: {
      accessValidUntil,
      status: hasRejected ? WorkerStatus.BLOCKED : WorkerStatus.ACTIVE,
    },
  });
}
