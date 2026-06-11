import { Router, type Request } from "express";
import { z } from "zod";
import {
  AccessDirection,
  AccessResult,
  DocumentStatus,
  DocumentType,
  RequirementCollectionStatus,
  WorkerStatus,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { Unauthorized } from "../../lib/errors.js";
import {
  isValidNeoAccessToken,
  normalizeScannedQr,
} from "../../utils/access-hash.js";
import { rewritePublicUrl } from "../../lib/public-url.js";
import { resolveNextDirection } from "./access.direction.js";

const NR_TYPES: DocumentType[] = [
  DocumentType.NR_10,
  DocumentType.NR_18,
  DocumentType.NR_35,
];

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
    case RequirementCollectionStatus.NOT_SENT:
      return "não enviado";
    case RequirementCollectionStatus.PENDING_APPROVAL:
      return "aguardando aprovação";
    case RequirementCollectionStatus.REJECTED:
      return "rejeitado";
    default:
      return status;
  }
}

interface PendingRequirementSummary {
  id: string;
  name: string;
  documentType: DocumentType;
  status: RequirementCollectionStatus;
  statusLabel: string;
}

async function fetchPendingRequirements(
  companyId: string,
  workerId: string,
): Promise<PendingRequirementSummary[]> {
  const items = await prisma.workerRequirementItem.findMany({
    where: {
      companyId,
      workerId,
      status: { in: PENDING_REQUIREMENT_STATUSES },
    },
    select: {
      id: true,
      name: true,
      documentType: true,
      status: true,
    },
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

const router = Router();
router.use(authenticate);

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

const scanSchema = z.object({
  /** Conteúdo lido do QR Code (token NEO- ou URL com ?t=). */
  qr: z.string().min(1),
  /**
   * Direção desejada. Se omitido (recomendado), o servidor decide pela paridade
   * dos scans anteriores: ENTRY se o último foi EXIT ou se não há histórico,
   * EXIT se o último foi ENTRY.
   */
  direction: z.nativeEnum(AccessDirection).optional(),
  gate: z.string().optional(),
});

router.post(
  "/scan",
  requireCapability("catraca.manage"),
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const { qr, direction: requestedDirection, gate } = scanSchema.parse(req.body);

    const token = normalizeScannedQr(qr);

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
          qrHash: isValidNeoAccessToken(token) ? token : null,
          operatorId: req.user!.id,
        },
      });
      return res.status(403).json({
        result: "DENIED",
        reason,
        direction: directionForLog,
        log,
        ...extra,
      });
    };

    if (!isValidNeoAccessToken(token)) {
      return deny("QR inválido — formato esperado: NEO-0A0AA0");
    }

    const worker = await prisma.worker.findFirst({
      where: { qrHash: token, companyId: company },
      include: {
        documents: {
          select: {
            id: true,
            type: true,
            title: true,
            status: true,
            expiresAt: true,
            issuedAt: true,
          },
          orderBy: { issuedAt: "desc" },
        },
        contractor: { select: { id: true, name: true } },
        function: { select: { id: true, name: true } },
        obra: { select: { id: true, name: true } },
      },
    });

    if (!worker) return deny("Colaborador não encontrado", undefined);

    const direction =
      requestedDirection ??
      (await resolveNextDirection({ companyId: company, workerId: worker.id }));

    // Colaborador precisa pertencer à obra que o porteiro escolheu no app.
    const activeObraId = req.user!.activeObraId;
    if (activeObraId && worker.obraId !== activeObraId) {
      return deny(
        `Colaborador é da obra "${worker.obra.name}" — esta portaria opera outra obra.`,
        worker.id,
        direction,
        {
          workerObra: { id: worker.obra.id, name: worker.obra.name },
        },
      );
    }

    if (worker.status === WorkerStatus.BLOCKED)
      return deny("Colaborador bloqueado", worker.id, direction);
    if (worker.status === WorkerStatus.INACTIVE)
      return deny("Colaborador inativo", worker.id, direction);

    const pendingRequirements = await fetchPendingRequirements(
      company,
      worker.id,
    );
    if (pendingRequirements.length > 0) {
      return deny(
        formatPendingReason(pendingRequirements),
        worker.id,
        direction,
        { pendingRequirements },
      );
    }

    if (worker.documents.some((d) => d.status === DocumentStatus.REJEITADO))
      return deny("Documentação rejeitada", worker.id, direction);
    if (worker.accessValidUntil && worker.accessValidUntil < new Date())
      return deny("Documentação vencida", worker.id, direction);

    const log = await prisma.accessLog.create({
      data: {
        companyId: company,
        workerId: worker.id,
        direction,
        result: AccessResult.GRANTED,
        gate,
        qrHash: token,
        operatorId: req.user!.id,
      },
    });

    const aso = worker.documents.find(
      (d) => d.type === DocumentType.ASO && d.status === DocumentStatus.APROVADO,
    );
    const nrs = worker.documents
      .filter(
        (d) =>
          NR_TYPES.includes(d.type) && d.status === DocumentStatus.APROVADO,
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
        role: worker.role,
        registration: worker.registration,
        photoUrl: rewritePublicUrl(worker.photoUrl, req),
        contractor: worker.contractor,
        function: worker.function,
        accessValidUntil: worker.accessValidUntil?.toISOString() ?? null,
        aso: aso
          ? {
              title: aso.title,
              expiresAt: aso.expiresAt?.toISOString() ?? null,
              issuedAt: aso.issuedAt?.toISOString() ?? null,
            }
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
  /** Opcional. Quando ausente, o servidor decide por paridade do histórico. */
  direction: z.nativeEnum(AccessDirection).optional(),
  gate: z.string().optional(),
  /** Timestamp do evento real na portaria (modo offline). */
  occurredAt: z.string().datetime({ offset: true }).optional(),
  /** ID local gerado pelo app — devolvido na resposta para o app casar com sua fila. */
  clientId: z.string().min(1).max(120).optional(),
});

const batchScanSchema = z.object({
  items: z.array(batchScanItemSchema).min(1).max(500),
});

/**
 * Recebe a fila de scans acumulados no modo offline e processa cada um
 * preservando a data real do evento (`occurredAt`). Aplica as mesmas
 * validações do scan unitário e devolve um relatório por item.
 */
router.post(
  "/scan/batch",
  requireCapability("catraca.manage"),
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const { items } = batchScanSchema.parse(req.body);

    const results = [] as Array<{
      clientId: string | null;
      result: "GRANTED" | "DENIED";
      reason?: string;
      logId: string;
      workerId?: string;
    }>;

    for (const item of items) {
      const token = normalizeScannedQr(item.qr);
      const occurredAt = item.occurredAt ? new Date(item.occurredAt) : new Date();

      const recordDeny = async (
        reason: string,
        directionForLog: AccessDirection,
        workerId?: string,
      ) => {
        const log = await prisma.accessLog.create({
          data: {
            companyId: company,
            workerId,
            direction: directionForLog,
            gate: item.gate,
            operatorId: req.user!.id,
            occurredAt,
            result: AccessResult.DENIED,
            reason,
            qrHash: isValidNeoAccessToken(token) ? token : null,
          },
        });
        results.push({
          clientId: item.clientId ?? null,
          result: "DENIED",
          reason,
          logId: log.id,
          workerId,
        });
      };

      if (!isValidNeoAccessToken(token)) {
        await recordDeny(
          "QR inválido — formato esperado: NEO-0A0AA0",
          item.direction ?? AccessDirection.ENTRY,
        );
        continue;
      }

      const worker = await prisma.worker.findFirst({
        where: { qrHash: token, companyId: company },
        include: {
          documents: { select: { status: true } },
          obra: { select: { id: true, name: true } },
        },
      });

      if (!worker) {
        await recordDeny(
          "Colaborador não encontrado",
          item.direction ?? AccessDirection.ENTRY,
        );
        continue;
      }

      const direction =
        item.direction ??
        (await resolveNextDirection({
          companyId: company,
          workerId: worker.id,
        }));

      const batchActiveObraId = req.user!.activeObraId;
      if (batchActiveObraId && worker.obraId !== batchActiveObraId) {
        await recordDeny(
          `Colaborador é da obra "${worker.obra.name}" — esta portaria opera outra obra.`,
          direction,
          worker.id,
        );
        continue;
      }

      if (worker.status === WorkerStatus.BLOCKED) {
        await recordDeny("Colaborador bloqueado", direction, worker.id);
        continue;
      }
      if (worker.status === WorkerStatus.INACTIVE) {
        await recordDeny("Colaborador inativo", direction, worker.id);
        continue;
      }

      const batchPending = await fetchPendingRequirements(company, worker.id);
      if (batchPending.length > 0) {
        await recordDeny(formatPendingReason(batchPending), direction, worker.id);
        continue;
      }

      if (worker.documents.some((d) => d.status === DocumentStatus.REJEITADO)) {
        await recordDeny("Documentação rejeitada", direction, worker.id);
        continue;
      }
      if (worker.accessValidUntil && worker.accessValidUntil < occurredAt) {
        await recordDeny("Documentação vencida", direction, worker.id);
        continue;
      }

      const log = await prisma.accessLog.create({
        data: {
          companyId: company,
          workerId: worker.id,
          direction,
          gate: item.gate,
          operatorId: req.user!.id,
          occurredAt,
          result: AccessResult.GRANTED,
          qrHash: token,
        },
      });
      results.push({
        clientId: item.clientId ?? null,
        result: "GRANTED",
        logId: log.id,
        workerId: worker.id,
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
  result: z.nativeEnum(AccessResult).optional(),
  direction: z.nativeEnum(AccessDirection).optional(),
  /** ISO date/datetime — filtra acessos a partir desse instante (inclusive). */
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  /** Filtro especial: "true" devolve apenas os registros operados pelo usuário autenticado. */
  mine: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const q = listSchema.parse(req.query);
    const where = {
      companyId: company,
      ...(q.workerId ? { workerId: q.workerId } : {}),
      ...(q.result ? { result: q.result } : {}),
      ...(q.direction ? { direction: q.direction } : {}),
      ...(q.from ? { occurredAt: { gte: q.from } } : {}),
      ...(q.mine ? { operatorId: req.user!.id } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.accessLog.count({ where }),
      prisma.accessLog.findMany({
        where,
        include: {
          worker: { select: { id: true, fullName: true, role: true } },
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
