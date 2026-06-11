import { Router, type Request } from "express";
import { RequirementCollectionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate } from "../../middleware/auth.js";
import { Unauthorized } from "../../lib/errors.js";
import {
  contractorScopeWhere,
  scopeFromRequest,
  workerScopeWhere,
} from "../../lib/scope.js";

const router = Router();
router.use(authenticate);

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

function emptyStatus() {
  return {
    [RequirementCollectionStatus.NOT_SENT]: 0,
    [RequirementCollectionStatus.PENDING_APPROVAL]: 0,
    [RequirementCollectionStatus.APPROVED]: 0,
    [RequirementCollectionStatus.REJECTED]: 0,
    [RequirementCollectionStatus.NOT_APPLICABLE]: 0,
  } as Record<string, number>;
}

function statusToChart(status: Record<string, number>) {
  return [
    { key: "nao_encaminhados", label: "Faltam registros", value: status.NOT_SENT },
    { key: "pendentes_aprovacao", label: "Aguardando avaliação", value: status.PENDING_APPROVAL },
    { key: "aprovados", label: "Aprovados", value: status.APPROVED },
    { key: "rejeitados", label: "Reprovados", value: status.REJECTED },
    { key: "na", label: "N/A", value: status.NOT_APPLICABLE },
  ];
}

router.get(
  "/compliance-overview",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const companyIdValue = scope.companyId;
    const workerScope = workerScopeWhere(scope);
    const contractorScope = contractorScopeWhere(scope);

    const [
      workerStatusGroups,
      contractorStatusGroups,
      workersCount,
      contractorsCount,
      topWorkerReqGroups,
      topContractorReqGroups,
    ] = await Promise.all([
      prisma.workerRequirementItem.groupBy({
        by: ["status"],
        where: { companyId: companyIdValue, worker: workerScope },
        _count: { _all: true },
      }),
      prisma.contractorRequirementItem.groupBy({
        by: ["status"],
        where: { companyId: companyIdValue, contractor: contractorScope },
        _count: { _all: true },
      }),
      prisma.worker.count({ where: workerScope }),
      prisma.contractor.count({ where: contractorScope }),
      // Top registros pendentes de colaboradores (faltando ou aguardando).
      prisma.workerRequirementItem.groupBy({
        by: ["name", "documentType"],
        where: {
          companyId: companyIdValue,
          worker: workerScope,
          status: {
            in: [
              RequirementCollectionStatus.NOT_SENT,
              RequirementCollectionStatus.PENDING_APPROVAL,
            ],
          },
        },
        _count: { _all: true },
        orderBy: { _count: { name: "desc" } },
        take: 5,
      }),
      // Top fornecedores com pendências.
      prisma.contractorRequirementItem.groupBy({
        by: ["contractorId"],
        where: {
          companyId: companyIdValue,
          contractor: contractorScope,
          status: {
            in: [
              RequirementCollectionStatus.NOT_SENT,
              RequirementCollectionStatus.PENDING_APPROVAL,
            ],
          },
        },
        _count: { _all: true },
        orderBy: { _count: { contractorId: "desc" } },
        take: 5,
      }),
    ]);

    const workerStatus = workerStatusGroups.reduce((acc, g) => {
      acc[g.status] = (acc[g.status] ?? 0) + g._count._all;
      return acc;
    }, emptyStatus());

    const contractorStatus = contractorStatusGroups.reduce((acc, g) => {
      acc[g.status] = (acc[g.status] ?? 0) + g._count._all;
      return acc;
    }, emptyStatus());

    const totals = emptyStatus();
    for (const key of Object.keys(totals)) {
      totals[key] = (workerStatus[key] ?? 0) + (contractorStatus[key] ?? 0);
    }

    // Resolve nomes dos fornecedores do top.
    const contractorIds = topContractorReqGroups.map((g) => g.contractorId);
    const contractorNames = contractorIds.length
      ? await prisma.contractor.findMany({
          where: { id: { in: contractorIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(contractorNames.map((c) => [c.id, c.name]));

    const sum = (s: Record<string, number>) =>
      Object.values(s).reduce((a, b) => a + b, 0);

    res.json({
      summary: { workers: workersCount, contractors: contractorsCount },
      workers: {
        total: workersCount,
        totalRegistros: sum(workerStatus),
        pendentes: workerStatus.NOT_SENT + workerStatus.PENDING_APPROVAL,
        status: workerStatus,
        chart: statusToChart(workerStatus),
      },
      contractors: {
        total: contractorsCount,
        totalRegistros: sum(contractorStatus),
        pendentes: contractorStatus.NOT_SENT + contractorStatus.PENDING_APPROVAL,
        status: contractorStatus,
        chart: statusToChart(contractorStatus),
      },
      topWorkerRequirements: topWorkerReqGroups.map((g) => ({
        name: g.name,
        documentType: g.documentType,
        count: g._count._all,
      })),
      topPendingContractors: topContractorReqGroups.map((g) => ({
        name: nameById.get(g.contractorId) ?? "—",
        count: g._count._all,
      })),
      requirementStatus: totals,
      chart: statusToChart(totals),
    });
  }),
);

export const reportRoutes = router;
