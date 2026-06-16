import {
  DocumentStatus,
  EffectiveRequirementStatus,
  RequirementCollectionStatus,
  RequirementStage,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/** Dias de antecedência em que um documento entra em "próximo do vencimento". */
export const PROX_VENCIMENTO_DIAS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Situação efetiva de uma exigência, derivada do status de coleta + validade
 * do documento aprovado. É o que alimenta os ícones do funil na UI.
 */
export function computeEffectiveStatus(
  status: RequirementCollectionStatus,
  expiresAt: Date | null,
  now: Date = new Date(),
): EffectiveRequirementStatus {
  switch (status) {
    case RequirementCollectionStatus.NOT_APPLICABLE:
      return EffectiveRequirementStatus.NA;
    case RequirementCollectionStatus.NOT_SENT:
      return EffectiveRequirementStatus.EM_FALTA;
    case RequirementCollectionStatus.PENDING_APPROVAL:
      return EffectiveRequirementStatus.AGUARDANDO;
    case RequirementCollectionStatus.REJECTED:
      return EffectiveRequirementStatus.REPROVADO;
    case RequirementCollectionStatus.APPROVED: {
      if (!expiresAt) return EffectiveRequirementStatus.VIGENTE;
      const diffDias = Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
      if (diffDias < 0) return EffectiveRequirementStatus.VENCIDO;
      if (diffDias <= PROX_VENCIMENTO_DIAS)
        return EffectiveRequirementStatus.PROX_VENCIMENTO;
      return EffectiveRequirementStatus.VIGENTE;
    }
    default:
      return EffectiveRequirementStatus.EM_FALTA;
  }
}

/** Estágio fino para a visão operacional (aba Pendentes). */
export function computeStage(
  status: RequirementCollectionStatus,
): RequirementStage {
  switch (status) {
    case RequirementCollectionStatus.NOT_SENT:
      return RequirementStage.AWAITING_UPLOAD;
    case RequirementCollectionStatus.PENDING_APPROVAL:
      return RequirementStage.AWAITING_REVIEW;
    default:
      return RequirementStage.NONE;
  }
}

/**
 * Recalcula e persiste `effectiveStatus`, `expiresAt` e `stage` de um item.
 * Use após qualquer mudança no status do item ou no documento vinculado.
 */
export async function recomputeRequirementItem(itemId: string): Promise<void> {
  const item = await prisma.workerRequirementItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      status: true,
      latestDocument: { select: { expiresAt: true } },
    },
  });
  if (!item) return;

  const expiresAt = item.latestDocument?.expiresAt ?? null;
  await prisma.workerRequirementItem.update({
    where: { id: item.id },
    data: {
      effectiveStatus: computeEffectiveStatus(item.status, expiresAt),
      stage: computeStage(item.status),
      expiresAt,
    },
  });
}

/** Recalcula todas as exigências de um colaborador (após aprovar/reprovar/anexar). */
export async function recomputeWorkerRequirements(
  workerId: string,
): Promise<void> {
  const items = await prisma.workerRequirementItem.findMany({
    where: { workerId },
    select: {
      id: true,
      status: true,
      latestDocument: { select: { expiresAt: true } },
    },
  });
  const now = new Date();
  await Promise.all(
    items.map((item) => {
      const expiresAt = item.latestDocument?.expiresAt ?? null;
      return prisma.workerRequirementItem.update({
        where: { id: item.id },
        data: {
          effectiveStatus: computeEffectiveStatus(item.status, expiresAt, now),
          stage: computeStage(item.status),
          expiresAt,
        },
      });
    }),
  );
}

/**
 * Reavaliação em massa para o job diário e o backfill no boot.
 * Só itens APROVADOS mudam de situação pela passagem do tempo
 * (VIGENTE → PROX_VENCIMENTO → VENCIDO), mas processamos todos os
 * que estiverem com `effectiveStatus` divergente para auto-corrigir.
 */
export async function recomputeStaleStatuses(
  batchSize = 1000,
): Promise<number> {
  const now = new Date();
  let processed = 0;
  let cursor: string | undefined;

  // Percorre em páginas por cursor para não carregar tudo em memória.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await prisma.workerRequirementItem.findMany({
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        status: true,
        effectiveStatus: true,
        latestDocument: { select: { expiresAt: true } },
      },
    });
    if (batch.length === 0) break;

    for (const item of batch) {
      const expiresAt = item.latestDocument?.expiresAt ?? null;
      const next = computeEffectiveStatus(item.status, expiresAt, now);
      if (next !== item.effectiveStatus) {
        await prisma.workerRequirementItem.update({
          where: { id: item.id },
          data: { effectiveStatus: next, expiresAt },
        });
        processed++;
      }
    }

    cursor = batch[batch.length - 1]!.id;
    if (batch.length < batchSize) break;
  }

  return processed;
}

/** Mapa de ícone/legenda para o frontend (alinha com as legendas do dashboard). */
export const EFFECTIVE_STATUS_META: Record<
  EffectiveRequirementStatus,
  { label: string; icon: string; blocks: boolean }
> = {
  EM_FALTA: { label: "Em falta", icon: "ban", blocks: true },
  AGUARDANDO: { label: "Aguardando avaliação", icon: "hourglass", blocks: true },
  REPROVADO: { label: "Reprovado", icon: "x", blocks: true },
  VENCIDO: { label: "Vencido", icon: "alert-triangle", blocks: true },
  PROX_VENCIMENTO: {
    label: "Próximo do vencimento",
    icon: "clock",
    blocks: false,
  },
  VIGENTE: { label: "Vigente", icon: "check", blocks: false },
  NA: { label: "Não aplicável", icon: "minus", blocks: false },
};

// Re-export para uso em outros módulos sem reimportar o enum do Prisma.
export { DocumentStatus };
