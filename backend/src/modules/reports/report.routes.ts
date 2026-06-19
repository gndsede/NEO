import { Router, type Request } from "express";
import { RequirementCollectionStatus } from "@prisma/client";
import type { EffectiveRequirementStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate } from "../../middleware/auth.js";
import {
  contractorScopeWhere,
  scopeFromRequest,
  workerScopeWhere,
} from "../../lib/scope.js";
import {
  reportAccess,
  reportCompliance,
  reportContractorPending,
  reportWorkers,
} from "./report.export.js";

const router = Router();
router.use(authenticate);

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

// ---------------------------------------------------------------------------
// Exportação: GET /reports/export/:tipo?format=xlsx|pdf
// ---------------------------------------------------------------------------

function parseFormat(req: Request): "xlsx" | "pdf" {
  const f = String(req.query.format ?? "xlsx").toLowerCase();
  return f === "pdf" ? "pdf" : "xlsx";
}

const VALID_ES = new Set([
  "EM_FALTA", "AGUARDANDO", "REPROVADO", "VIGENTE", "PROX_VENCIMENTO", "VENCIDO", "NA",
]);

function parseEffectiveStatus(raw: unknown): EffectiveRequirementStatus[] | undefined {
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  const valid = arr.map((v) => String(v).trim()).filter((v) => VALID_ES.has(v));
  return valid.length ? (valid as EffectiveRequirementStatus[]) : undefined;
}

router.get(
  "/export/workers",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    await reportWorkers(
      scope,
      {
        contractorId: req.query.contractorId ? String(req.query.contractorId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      },
      parseFormat(req),
      res,
    );
  }),
);

router.get(
  "/export/compliance",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    await reportCompliance(
      scope,
      {
        contractorId: req.query.contractorId ? String(req.query.contractorId) : undefined,
        effectiveStatus: parseEffectiveStatus(req.query.effectiveStatus),
      },
      parseFormat(req),
      res,
    );
  }),
);

router.get(
  "/export/access",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    await reportAccess(
      scope,
      {
        from: from && !Number.isNaN(from.getTime()) ? from : undefined,
        to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        obraId: req.query.obraId ? String(req.query.obraId) : undefined,
      },
      parseFormat(req),
      res,
    );
  }),
);

router.get(
  "/export/contractor-pending",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    await reportContractorPending(
      scope,
      {
        obraId: req.query.obraId ? String(req.query.obraId) : undefined,
      },
      parseFormat(req),
      res,
    );
  }),
);

export const reportRoutes = router;
