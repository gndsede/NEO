import {
  LifecyclePhase,
  RequirementCollectionStatus,
  RequirementSource,
  RequirementTarget,
  WorkerStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { BadRequest } from "../../lib/errors.js";

/** Rótulo da fase no cadastro de registros documentais. */
export const PHASE_LABEL: Record<LifecyclePhase, string> = {
  ENTRADA: "Documentação de entrada",
  ATIVIDADE: "Documentação de atividade",
  SAIDA: "Documentação de saída",
};

/** Rótulo da fase do ponto de vista do vínculo do colaborador. */
export const ASSIGNMENT_PHASE_LABEL: Record<LifecyclePhase, string> = {
  ENTRADA: "Em entrada",
  ATIVIDADE: "Em atividade",
  SAIDA: "Em processo demissional",
};

/** Uma exigência está resolvida quando foi aprovada ou dispensada com motivo. */
export const RESOLVED_STATUSES: RequirementCollectionStatus[] = [
  RequirementCollectionStatus.APPROVED,
  RequirementCollectionStatus.NOT_APPLICABLE,
];

/**
 * Fases cujas exigências devem existir para um vínculo na fase informada.
 *
 * Quem está em ENTRADA já recebe também as cobranças de atividade — a
 * documentação periódica começa a correr junto com a admissional. As de saída
 * só nascem quando o processo demissional é aberto, para não poluir o funil.
 */
export function phasesToMaterialize(current: LifecyclePhase): LifecyclePhase[] {
  switch (current) {
    case LifecyclePhase.ENTRADA:
      return [LifecyclePhase.ENTRADA, LifecyclePhase.ATIVIDADE];
    case LifecyclePhase.ATIVIDADE:
      return [LifecyclePhase.ATIVIDADE];
    case LifecyclePhase.SAIDA:
      return [LifecyclePhase.ATIVIDADE, LifecyclePhase.SAIDA];
  }
}

/**
 * Cria os itens de coleta das fases informadas a partir do template da função.
 * Um registro cobrado em duas fases gera dois itens (um por fase) — são coletas
 * distintas. Não duplica o que já existe para o par (registro, fase).
 *
 * Retorna quantos itens foram criados em cada fase.
 */
export async function materializeRequirementsForPhases(
  tx: Prisma.TransactionClient,
  params: {
    companyId: string;
    workerId: string;
    assignmentId: string;
    functionId: string;
    phases: LifecyclePhase[];
    createdById?: string;
  },
): Promise<Record<LifecyclePhase, number>> {
  const created: Record<LifecyclePhase, number> = {
    ENTRADA: 0,
    ATIVIDADE: 0,
    SAIDA: 0,
  };
  if (params.phases.length === 0) return created;

  const rels = await tx.workerFunctionRequirement.findMany({
    where: {
      functionId: params.functionId,
      required: true,
      requirement: {
        companyId: params.companyId,
        active: true,
        target: RequirementTarget.WORKER,
        phases: { hasSome: params.phases },
      },
    },
    include: { requirement: true },
  });
  if (rels.length === 0) return created;

  const existing = await tx.workerRequirementItem.findMany({
    where: {
      companyId: params.companyId,
      assignmentId: params.assignmentId,
      source: RequirementSource.FUNCTION_TEMPLATE,
      requirementId: { not: null },
    },
    select: { requirementId: true, phase: true },
  });
  const seen = new Set(existing.map((e) => `${e.requirementId}:${e.phase}`));

  for (const rel of rels) {
    const def = rel.requirement;
    for (const phase of def.phases) {
      if (!params.phases.includes(phase)) continue;
      if (seen.has(`${def.id}:${phase}`)) continue;
      seen.add(`${def.id}:${phase}`);
      await tx.workerRequirementItem.create({
        data: {
          companyId: params.companyId,
          workerId: params.workerId,
          assignmentId: params.assignmentId,
          requirementId: def.id,
          source: RequirementSource.FUNCTION_TEMPLATE,
          status: RequirementCollectionStatus.NOT_SENT,
          name: def.name,
          documentType: def.documentType,
          frequency: def.frequency,
          monthlyDueDay: def.monthlyDueDay ?? undefined,
          referenceDate: def.referenceDate ?? undefined,
          phase,
          createdById: params.createdById,
        },
      });
      created[phase] += 1;
    }
  }

  return created;
}

export interface PhaseGate {
  phase: LifecyclePhase;
  total: number;
  resolved: number;
  /** Exigências da fase que ainda impedem o avanço. */
  pending: Array<{ id: string; name: string; status: RequirementCollectionStatus }>;
  clear: boolean;
}

/** Situação da coleta de uma fase para um vínculo. */
export async function readPhaseGate(
  client: Prisma.TransactionClient,
  assignmentId: string,
  phase: LifecyclePhase,
): Promise<PhaseGate> {
  const items = await client.workerRequirementItem.findMany({
    where: { assignmentId, phase },
    select: { id: true, name: true, status: true },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  const pending = items.filter((i) => !RESOLVED_STATUSES.includes(i.status));
  return {
    phase,
    total: items.length,
    resolved: items.length - pending.length,
    pending,
    clear: pending.length === 0,
  };
}

function gateError(gate: PhaseGate, action: string): never {
  const nomes = gate.pending
    .slice(0, 5)
    .map((p) => p.name)
    .join(", ");
  const resto = gate.pending.length > 5 ? ` e mais ${gate.pending.length - 5}` : "";
  throw BadRequest(
    `${action}: faltam ${gate.pending.length} de ${gate.total} documentos de ` +
      `${PHASE_LABEL[gate.phase].toLowerCase()} (${nomes}${resto}). ` +
      "Aprove ou marque como não aplicável antes de prosseguir.",
  );
}

/**
 * Move o vínculo para outra fase, aplicando as travas do processo:
 * ENTRADA → ATIVIDADE exige a documentação de entrada resolvida.
 * Entrar em SAIDA materializa as exigências de desligamento.
 */
export async function transitionAssignmentPhase(params: {
  companyId: string;
  assignmentId: string;
  to: LifecyclePhase;
  createdById?: string;
}) {
  const assignment = await prisma.workerAssignment.findFirst({
    where: { id: params.assignmentId, companyId: params.companyId },
    select: {
      id: true,
      phase: true,
      status: true,
      workerId: true,
      functionId: true,
    },
  });
  if (!assignment) throw BadRequest("Vínculo não encontrado");
  if (assignment.phase === params.to) return assignment;

  if (
    assignment.phase === LifecyclePhase.ENTRADA &&
    params.to === LifecyclePhase.ATIVIDADE
  ) {
    const gate = await readPhaseGate(prisma, assignment.id, LifecyclePhase.ENTRADA);
    if (!gate.clear) {
      gateError(gate, "Não é possível liberar o colaborador para atividade");
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.workerAssignment.update({
      where: { id: assignment.id },
      data: { phase: params.to, phaseUpdatedAt: new Date() },
    });

    if (assignment.functionId) {
      await materializeRequirementsForPhases(tx, {
        companyId: params.companyId,
        workerId: assignment.workerId,
        assignmentId: assignment.id,
        functionId: assignment.functionId,
        phases: phasesToMaterialize(params.to),
        createdById: params.createdById,
      });
    }

    return updated;
  });
}

/**
 * Trava da inativação: só sai da obra quem passou pelo processo demissional
 * com a documentação de saída resolvida.
 */
export async function assertCanInactivate(
  companyId: string,
  assignmentId: string,
): Promise<void> {
  const assignment = await prisma.workerAssignment.findFirst({
    where: { id: assignmentId, companyId },
    select: { phase: true, status: true },
  });
  if (!assignment) throw BadRequest("Vínculo não encontrado");
  if (assignment.status === WorkerStatus.INACTIVE) return;

  if (assignment.phase !== LifecyclePhase.SAIDA) {
    throw BadRequest(
      "Antes de inativar, abra o processo demissional para cobrar a documentação de saída.",
    );
  }
  const gate = await readPhaseGate(prisma, assignmentId, LifecyclePhase.SAIDA);
  if (!gate.clear) gateError(gate, "Não é possível inativar o colaborador");
}

/**
 * Promove automaticamente para ATIVIDADE quando a última pendência de entrada
 * é resolvida (aprovação de documento ou marcação de não aplicável).
 *
 * Também cobre o caso de a empresa não ter nenhuma exigência de entrada
 * configurada: sem itens na fase, o vínculo não fica preso na portaria.
 */
export async function autoAdvanceFromEntrada(
  assignmentId: string | null | undefined,
): Promise<LifecyclePhase | null> {
  if (!assignmentId) return null;
  const assignment = await prisma.workerAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, phase: true },
  });
  if (!assignment || assignment.phase !== LifecyclePhase.ENTRADA) return null;

  const gate = await readPhaseGate(prisma, assignment.id, LifecyclePhase.ENTRADA);
  if (!gate.clear) return null;

  await prisma.workerAssignment.update({
    where: { id: assignment.id },
    data: { phase: LifecyclePhase.ATIVIDADE, phaseUpdatedAt: new Date() },
  });
  return LifecyclePhase.ATIVIDADE;
}

/** Roda o auto-avanço para todos os vínculos em entrada de um colaborador. */
export async function autoAdvanceWorkerAssignments(
  workerId: string,
): Promise<void> {
  const assignments = await prisma.workerAssignment.findMany({
    where: { workerId, phase: LifecyclePhase.ENTRADA },
    select: { id: true },
  });
  for (const a of assignments) {
    await autoAdvanceFromEntrada(a.id);
  }
}
