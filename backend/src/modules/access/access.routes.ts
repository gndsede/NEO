import { Router, type Request } from "express";
import { z } from "zod";
import {
  AccessDirection,
  AccessResult,
  DocumentStatus,
  DocumentType,
  Prisma,
  RequirementCollectionStatus,
  WorkerStatus,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { Unauthorized } from "../../lib/errors.js";
import { resolveScannedToken } from "../../utils/access-hash.js";
import { rewritePublicUrl } from "../../lib/public-url.js";
import { resolveNextDirection } from "./access.direction.js";

const NR_TITLE_PATTERN = /\bNR[\s-]?(10|18|35)\b/i;
const ASO_TITLE_PATTERN = /\bASO\b/i;

function pickEarliest(dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  if (valid.length === 0) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

const PENDING_REQUIREMENT_STATUSES: RequirementCollectionStatus[] = [
  RequirementCollectionStatus.NOT_SENT,
  RequirementCollectionStatus.PENDING_APPROVAL,
  RequirementCollectionStatus.REJECTED,
];

function statusLabel(status: RequirementCollectionStatus): string {
  switch (status) {
    case RequirementCollectionStatus.NOT_SENT: return "não enviado";
    case RequirementCollectionStatus.PENDING_APPROVAL: return "aguardando aprovação";
    case RequirementCollectionStatus.REJECTED: return "rejeitado";
    default: return status;
  }
}

interface PendingRequirementSummary {
  id: string;
  name: string;
  documentType: DocumentType;
  status: RequirementCollectionStatus;
  statusLabel: string;
}

/**
 * Busca pendências de um colaborador, opcionalmente filtradas por assignmentId
 * (para verificar somente os requisitos da obra específica da portaria).
 */
async function fetchPendingRequirements(
  companyId: string,
  workerId: string,
  assignmentId?: string,
): Promise<PendingRequirementSummary[]> {
  const items = await prisma.workerRequirementItem.findMany({
    where: {
      companyId,
      workerId,
      ...(assignmentId ? { assignmentId } : {}),
      status: { in: PENDING_REQUIREMENT_STATUSES },
    },
    select: { id: true, name: true, documentType: true, status: true },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    documentType: i.documentType,
    status: i.status,
    statusLabel: statusLabel(i.status),
  }));
}

function formatPendingReason(items: PendingRequirementSummary[]): string {
  const names = items.slice(0, 3).map((i) => i.name);
  const extra = items.length - names.length;
  const list = names.join(", ") + (extra > 0 ? ` (e mais ${extra})` : "");
  return `Documentação pendente: ${list}`;
}

async function createBatchLog(params: {
  companyId: string;
  clientId?: string;
  data: Omit<Prisma.AccessLogUncheckedCreateInput, "companyId" | "clientId">;
}) {
  const { companyId, clientId, data } = params;
  try {
    return await prisma.accessLog.create({
      data: { ...data, companyId, clientId: clientId ?? null },
    });
  } catch (e) {
    if (
      clientId &&
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      const existing = await prisma.accessLog.findUnique({
        where: { companyId_clientId: { companyId, clientId } },
      });
      if (existing) return existing;
    }
    throw e;
  }
}

const router = Router();
router.use(authenticate);

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

const scanSchema = z.object({
  qr: z.string().min(1),
  direction: z.nativeEnum(AccessDirection).optional(),
  gate: z.string().optional(),
  override: z.boolean().optional(),
});

router.post(
  "/scan",
  requireCapability("catraca.manage"),
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const { qr, direction: requestedDirection, gate, override } = scanSchema.parse(req.body);
    // Verifica assinatura HMAC do crachá (quando presente) e extrai o token base.
    const resolved = resolveScannedToken(qr);
    const token = resolved.token;

    const deny = async (
      reason: string,
      workerId?: string,
      directionForLog: AccessDirection = AccessDirection.ENTRY,
      extra: Record<string, unknown> = {},
    ) => {
      const log = await prisma.accessLog.create({
        data: {
          companyId: company,
          workerId,
          direction: directionForLog,
          result: AccessResult.DENIED,
          reason,
          gate,
          qrHash: token,
          operatorId: req.user!.id,
        },
      });
      return res.status(403).json({ result: "DENIED", reason, direction: directionForLog, log, ...extra });
    };

    if (!token) {
      return deny(resolved.error ?? "QR inválido — formato esperado: NEO-0A0AA0");
    }

    // Busca o colaborador pelo token
    const worker = await prisma.worker.findFirst({
      where: { qrHash: token, companyId: company },
      include: {
        documents: {
          select: { id: true, type: true, title: true, status: true, expiresAt: true, issuedAt: true },
          orderBy: { issuedAt: "desc" },
        },
      },
    });

    if (!worker) return deny("Colaborador não encontrado");

    const direction =
      requestedDirection ??
      (await resolveNextDirection({ companyId: company, workerId: worker.id }));

    // Anti-passback estrito: bloqueia ENTRY duplicado sem EXIT intermediário.
    // Aplica quando a direção é ENTRY (auto-resolvida ou explícita) e o último
    // acesso GRANTED registrado também foi ENTRY — indica badge compartilhado ou
    // entrada sem registrar saída.
    if (!override && direction === AccessDirection.ENTRY) {
      const lastGranted = await prisma.accessLog.findFirst({
        where: { companyId: company, workerId: worker.id, result: AccessResult.GRANTED },
        orderBy: { occurredAt: "desc" },
        select: { direction: true },
      });
      if (lastGranted?.direction === AccessDirection.ENTRY) {
        return deny(
          "Anti-passback: colaborador está com entrada registrada sem saída correspondente.",
          worker.id,
          direction,
          { antiPassback: true },
        );
      }
    }

    // Verifica assignment na obra ativa da portaria
    const activeObraId = req.user!.activeObraId;
    let assignment: { id: string; status: string; accessValidUntil: Date | null; role: string; registration: string | null; contractor: { id: string; name: string }; function: { id: string; name: string } | null; } | null = null;

    if (activeObraId) {
      assignment = await prisma.workerAssignment.findUnique({
        where: { obraId_workerId: { obraId: activeObraId, workerId: worker.id } },
        include: {
          contractor: { select: { id: true, name: true } },
          function: { select: { id: true, name: true } },
        },
      });

      if (!assignment) {
        // Colaborador não tem vínculo com esta obra específica
        const allAssignments = await prisma.workerAssignment.findMany({
          where: { workerId: worker.id, companyId: company },
          include: { obra: { select: { name: true } } },
          take: 3,
        });
        const obraNames = allAssignments.map((a) => a.obra.name).join(", ");
        return deny(
          `Colaborador não tem vínculo com esta obra. Obras cadastradas: ${obraNames || "nenhuma"}.`,
          worker.id,
          direction,
        );
      }
    } else {
      // Sem obra ativa → busca qualquer assignment ativo
      assignment = await prisma.workerAssignment.findFirst({
        where: { workerId: worker.id, companyId: company, status: WorkerStatus.ACTIVE },
        include: {
          contractor: { select: { id: true, name: true } },
          function: { select: { id: true, name: true } },
        },
      });
    }

    if (!assignment) {
      return deny("Colaborador sem vínculo ativo com nenhuma obra", worker.id, direction);
    }

    if (assignment.status === WorkerStatus.BLOCKED)
      return deny("Colaborador bloqueado nesta obra", worker.id, direction);
    if (assignment.status === WorkerStatus.INACTIVE)
      return deny("Colaborador inativo nesta obra", worker.id, direction);

    // Verifica pendências scoped ao assignment desta obra
    const pendingRequirements = await fetchPendingRequirements(
      company,
      worker.id,
      assignment.id,
    );
    if (!override && pendingRequirements.length > 0) {
      return deny(
        formatPendingReason(pendingRequirements),
        worker.id,
        direction,
        { pendingRequirements },
      );
    }

    if (!override && worker.documents.some((d) => d.status === DocumentStatus.REJEITADO))
      return deny("Documentação rejeitada", worker.id, direction);
    if (!override && assignment.accessValidUntil && assignment.accessValidUntil < new Date())
      return deny("Documentação vencida", worker.id, direction);

    let log;
    if (override) {
      const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000);
      const recentDenied = await prisma.accessLog.findFirst({
        where: {
          companyId: company,
          workerId: worker.id,
          result: AccessResult.DENIED,
          occurredAt: { gte: twoMinsAgo },
        },
        orderBy: { occurredAt: "desc" },
      });
      if (recentDenied) {
        log = await prisma.accessLog.update({
          where: { id: recentDenied.id },
          data: {
            direction,
            result: AccessResult.GRANTED,
            reason: "Liberação manual (com pendências)",
            operatorId: req.user!.id,
          },
        });
      }
    }

    if (!log) {
      log = await prisma.accessLog.create({
        data: {
          companyId: company,
          workerId: worker.id,
          direction,
          result: AccessResult.GRANTED,
          reason: override ? "Liberação manual (com pendências)" : null,
          gate,
          qrHash: token,
          operatorId: req.user!.id,
        },
      });
    }

    const aso = worker.documents.find(
      (d) =>
        d.type === DocumentType.SAFETY &&
        d.status === DocumentStatus.APROVADO &&
        ASO_TITLE_PATTERN.test(d.title ?? ""),
    );
    const nrs = worker.documents
      .filter(
        (d) =>
          d.type === DocumentType.SAFETY &&
          d.status === DocumentStatus.APROVADO &&
          NR_TITLE_PATTERN.test(d.title ?? ""),
      )
      .map((d) => ({
        type: d.type,
        title: d.title,
        expiresAt: d.expiresAt?.toISOString() ?? null,
      }));

    res.json({
      result: "GRANTED",
      direction,
      accessToken: token,
      worker: {
        id: worker.id,
        fullName: worker.fullName,
        role: assignment.role,
        registration: assignment.registration,
        photoUrl: rewritePublicUrl(worker.photoUrl, req),
        contractor: assignment.contractor,
        function: assignment.function,
        accessValidUntil: assignment.accessValidUntil?.toISOString() ?? null,
        aso: aso
          ? { title: aso.title, expiresAt: aso.expiresAt?.toISOString() ?? null, issuedAt: aso.issuedAt?.toISOString() ?? null }
          : null,
        nrs,
        nextExpiringDoc: pickEarliest(
          worker.documents
            .filter((d) => d.status === DocumentStatus.APROVADO)
            .map((d) => d.expiresAt),
        )?.toISOString() ?? null,
      },
      log,
    });
  }),
);

const batchScanItemSchema = z.object({
  qr: z.string().min(1),
  direction: z.nativeEnum(AccessDirection).optional(),
  gate: z.string().optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  clientId: z.string().min(1).max(120).optional(),
  override: z.boolean().optional(),
});

const batchScanSchema = z.object({
  items: z.array(batchScanItemSchema).min(1).max(500),
});

router.post(
  "/scan/batch",
  requireCapability("catraca.manage"),
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const { items } = batchScanSchema.parse(req.body);
    const batchActiveObraId = req.user!.activeObraId;

    const results = [] as Array<{
      clientId: string | null;
      result: "GRANTED" | "DENIED";
      reason?: string;
      logId: string;
      workerId?: string;
    }>;

    for (const item of items) {
      // Verifica assinatura HMAC do crachá (quando presente) e extrai o token base.
      const itemResolved = resolveScannedToken(item.qr);
      const token = itemResolved.token;
      const occurredAt = item.occurredAt ? new Date(item.occurredAt) : new Date();

      if (item.clientId) {
        const existing = await prisma.accessLog.findUnique({
          where: { companyId_clientId: { companyId: company, clientId: item.clientId } },
          select: { id: true, result: true, reason: true, workerId: true },
        });
        if (existing) {
          results.push({
            clientId: item.clientId,
            result: existing.result === AccessResult.GRANTED ? "GRANTED" : "DENIED",
            reason: existing.reason ?? undefined,
            logId: existing.id,
            workerId: existing.workerId ?? undefined,
          });
          continue;
        }
      }

      const recordDeny = async (
        reason: string,
        directionForLog: AccessDirection,
        workerId?: string,
      ) => {
        const log = await createBatchLog({
          companyId: company,
          clientId: item.clientId,
          data: {
            workerId,
            direction: directionForLog,
            gate: item.gate,
            operatorId: req.user!.id,
            occurredAt,
            result: AccessResult.DENIED,
            reason,
            qrHash: token,
          },
        });
        results.push({
          clientId: item.clientId ?? null,
          result: log.result === AccessResult.GRANTED ? "GRANTED" : "DENIED",
          reason: log.reason ?? reason,
          logId: log.id,
          workerId: log.workerId ?? workerId,
        });
      };

      if (!token) {
        await recordDeny(
          itemResolved.error ?? "QR inválido — formato esperado: NEO-0A0AA0",
          item.direction ?? AccessDirection.ENTRY,
        );
        continue;
      }

      const worker = await prisma.worker.findFirst({
        where: { qrHash: token, companyId: company },
        include: { documents: { select: { status: true } } },
      });

      if (!worker) {
        await recordDeny("Colaborador não encontrado", item.direction ?? AccessDirection.ENTRY);
        continue;
      }

      const direction =
        item.direction ??
        (await resolveNextDirection({ companyId: company, workerId: worker.id }));

      // Busca assignment na obra desta portaria
      let assignment: { id: string; status: string; accessValidUntil: Date | null } | null = null;

      if (batchActiveObraId) {
        assignment = await prisma.workerAssignment.findUnique({
          where: { obraId_workerId: { obraId: batchActiveObraId, workerId: worker.id } },
          select: { id: true, status: true, accessValidUntil: true },
        });

        if (!assignment) {
          await recordDeny("Colaborador não tem vínculo com esta obra", direction, worker.id);
          continue;
        }
      } else {
        assignment = await prisma.workerAssignment.findFirst({
          where: { workerId: worker.id, companyId: company, status: WorkerStatus.ACTIVE },
          select: { id: true, status: true, accessValidUntil: true },
        });
      }

      if (!assignment) {
        await recordDeny("Colaborador sem vínculo ativo", direction, worker.id);
        continue;
      }

      if (assignment.status === WorkerStatus.BLOCKED) {
        await recordDeny("Colaborador bloqueado", direction, worker.id);
        continue;
      }
      if (assignment.status === WorkerStatus.INACTIVE) {
        await recordDeny("Colaborador inativo", direction, worker.id);
        continue;
      }

      const batchPending = await fetchPendingRequirements(company, worker.id, assignment.id);
      if (!item.override && batchPending.length > 0) {
        await recordDeny(formatPendingReason(batchPending), direction, worker.id);
        continue;
      }

      if (!item.override && worker.documents.some((d) => d.status === DocumentStatus.REJEITADO)) {
        await recordDeny("Documentação rejeitada", direction, worker.id);
        continue;
      }
      if (!item.override && assignment.accessValidUntil && assignment.accessValidUntil < occurredAt) {
        await recordDeny("Documentação vencida", direction, worker.id);
        continue;
      }

      let log;
      if (item.override) {
        const twoMinsAgo = new Date(occurredAt.getTime() - 2 * 60 * 1000);
        const recentDenied = await prisma.accessLog.findFirst({
          where: {
            companyId: company,
            workerId: worker.id,
            result: AccessResult.DENIED,
            occurredAt: { gte: twoMinsAgo, lte: occurredAt },
          },
          orderBy: { occurredAt: "desc" },
        });
        if (recentDenied) {
          log = await prisma.accessLog.update({
            where: { id: recentDenied.id },
            data: {
              direction,
              result: AccessResult.GRANTED,
              reason: "Liberação manual (com pendências)",
              operatorId: req.user!.id,
              clientId: item.clientId,
            },
          });
        }
      }

      if (!log) {
        log = await createBatchLog({
          companyId: company,
          clientId: item.clientId,
          data: {
            workerId: worker.id,
            direction,
            gate: item.gate,
            operatorId: req.user!.id,
            occurredAt,
            result: AccessResult.GRANTED,
            reason: item.override ? "Liberação manual (com pendências)" : null,
            qrHash: token,
          },
        });
      }
      results.push({
        clientId: item.clientId ?? null,
        result: log.result === AccessResult.GRANTED ? "GRANTED" : "DENIED",
        reason: log.reason ?? undefined,
        logId: log.id,
        workerId: log.workerId ?? worker.id,
      });
    }

    res.json({
      processed: results.length,
      granted: results.filter((r) => r.result === "GRANTED").length,
      denied: results.filter((r) => r.result === "DENIED").length,
      results,
    });
  }),
);

const listSchema = z.object({
  workerId: z.string().optional(),
  workerName: z.string().optional(),
  result: z.nativeEnum(AccessResult).optional(),
  direction: z.nativeEnum(AccessDirection).optional(),
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  mine: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

router.get(
  "/today-summary",
  requireCapability("catraca.view", "catraca.manage"),
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const scope = req.user!;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    // Scope logs to the user's obra(s)
    const obraFilter = scope.activeObraId
      ? { worker: { assignments: { some: { obraId: scope.activeObraId } } } }
      : scope.obraIds.length > 0
        ? { worker: { assignments: { some: { obraId: { in: scope.obraIds } } } } }
        : {};

    const logs = await prisma.accessLog.findMany({
      where: { companyId: company, occurredAt: { gte: dayStart }, ...obraFilter },
      select: { occurredAt: true, direction: true, result: true },
      orderBy: { occurredAt: "asc" },
    });

    let entries = 0, exits = 0, denied = 0;
    const hourlyMap: Record<number, { entries: number; exits: number }> = {};

    for (const log of logs) {
      const h = new Date(log.occurredAt).getHours();
      if (!hourlyMap[h]) hourlyMap[h] = { entries: 0, exits: 0 };
      if (log.result === "DENIED") {
        denied++;
      } else if (log.direction === "ENTRY") {
        entries++;
        hourlyMap[h].entries++;
      } else {
        exits++;
        hourlyMap[h].exits++;
      }
    }

    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      entries: hourlyMap[h]?.entries ?? 0,
      exits: hourlyMap[h]?.exits ?? 0,
    }));

    res.json({ entries, exits, denied, total: logs.length, hourly });
  }),
);

router.get(
  "/",
  requireCapability("catraca.view", "catraca.manage"),
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const scope = req.user!;
    const q = listSchema.parse(req.query);

    const occurredAt: { gte?: Date; lte?: Date } = {};
    if (q.from) occurredAt.gte = q.from;
    if (q.to) occurredAt.lte = q.to;

    // Scope to the user's obra(s) and contractor (for COLLABORATOR role)
    const assignmentScope: Record<string, unknown> = {};
    if (scope.activeObraId) assignmentScope.obraId = scope.activeObraId;
    else if (scope.obraIds.length > 0) assignmentScope.obraId = { in: scope.obraIds };
    if (scope.profile === "COLLABORATOR" && scope.contractorId) {
      assignmentScope.contractorId = scope.contractorId;
    }
    const workerScopeFilter = Object.keys(assignmentScope).length > 0
      ? { worker: { assignments: { some: assignmentScope } } }
      : {};

    const where = {
      companyId: company,
      ...workerScopeFilter,
      ...(q.workerId ? { workerId: q.workerId } : {}),
      ...(q.workerName
        ? { worker: { fullName: { contains: q.workerName, mode: "insensitive" as const } } }
        : {}),
      ...(q.result ? { result: q.result } : {}),
      ...(q.direction ? { direction: q.direction } : {}),
      ...(Object.keys(occurredAt).length ? { occurredAt } : {}),
      ...(q.mine ? { operatorId: req.user!.id } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.accessLog.count({ where }),
      prisma.accessLog.findMany({
        where,
        include: {
          worker: {
            select: {
              id: true,
              fullName: true,
              assignments: {
                select: { role: true, contractor: { select: { id: true, name: true } } },
                take: 1,
                orderBy: { createdAt: "asc" },
              },
            },
          },
        },
        orderBy: { occurredAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    res.json({
      items,
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    });
  }),
);

export const accessRoutes = router;
