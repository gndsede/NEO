import { Router, type Request } from "express";
import { z } from "zod";
import {
  DocumentStatus,
  RequirementCollectionStatus,
  WorkerStatus,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { Unauthorized } from "../../lib/errors.js";
import { ensureObraAccess, scopeFromRequest } from "../../lib/scope.js";

const router = Router();
router.use(authenticate);

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

const syncQuerySchema = z.object({
  /** ISO timestamp do último sync bem-sucedido. Se ausente, retorna todos os ativos. */
  since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  limit: z.coerce.number().int().positive().max(2000).default(1000),
});

/**
 * Sync incremental para o app da catraca.
 * - Sem ?since: devolve TODOS os colaboradores ativos da obra (carga inicial).
 * - Com ?since: devolve só os que mudaram desde o timestamp + lista de revogados.
 *
 * O app armazena tudo em SQLite local e usa para validar acesso em modo offline.
 */
router.get(
  "/obra/:obraId",
  requireCapability("catraca.manage"),
  asyncHandler(async (req, res) => {
    const company = companyId(req);
    const scope = scopeFromRequest(req);
    const obraId = String(req.params.obraId);
    await ensureObraAccess(scope, obraId);

    const { since, limit } = syncQuerySchema.parse(req.query);

    const baseWhere = {
      companyId: company,
      obraId,
    };

    const upsertsWhere = since
      ? { ...baseWhere, updatedAt: { gte: since } }
      : { ...baseWhere, status: { not: WorkerStatus.INACTIVE } };

    const workers = await prisma.worker.findMany({
      where: upsertsWhere,
      select: {
        id: true,
        qrHash: true,
        fullName: true,
        cpf: false,
        role: true,
        registration: true,
        photoUrl: true,
        status: true,
        accessValidUntil: true,
        updatedAt: true,
        contractor: { select: { id: true, name: true } },
        function: { select: { id: true, name: true } },
        documents: {
          where: { status: DocumentStatus.REJEITADO },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    let revokedTokens: string[] = [];
    if (since) {
      const revoked = await prisma.worker.findMany({
        where: {
          ...baseWhere,
          updatedAt: { gte: since },
          status: WorkerStatus.INACTIVE,
        },
        select: { qrHash: true },
      });
      revokedTokens = revoked.map((w) => w.qrHash);
    }

    // Consolida quais workers do lote têm exigências documentais pendentes,
    // para que o app possa bloquear offline com o mesmo critério do online.
    const workerIds = workers.map((w) => w.id);
    const pendingSet = new Set<string>();
    if (workerIds.length > 0) {
      const pending = await prisma.workerRequirementItem.findMany({
        where: {
          companyId: company,
          workerId: { in: workerIds },
          status: {
            in: [
              RequirementCollectionStatus.NOT_SENT,
              RequirementCollectionStatus.PENDING_APPROVAL,
              RequirementCollectionStatus.REJECTED,
            ],
          },
        },
        select: { workerId: true },
        distinct: ["workerId"],
      });
      for (const p of pending) pendingSet.add(p.workerId);
    }

    const now = new Date();

    res.json({
      obraId,
      serverTime: now.toISOString(),
      since: since?.toISOString() ?? null,
      isInitialSync: !since,
      total: workers.length,
      workers: workers.map((w) => ({
        id: w.id,
        token: w.qrHash,
        fullName: w.fullName,
        role: w.role,
        registration: w.registration,
        photoUrl: w.photoUrl,
        status: w.status,
        accessValidUntil: w.accessValidUntil?.toISOString() ?? null,
        hasRejectedDocument: w.documents.length > 0,
        hasPendingRequirements: pendingSet.has(w.id),
        contractor: w.contractor
          ? { id: w.contractor.id, name: w.contractor.name }
          : null,
        function: w.function
          ? { id: w.function.id, name: w.function.name }
          : null,
        updatedAt: w.updatedAt.toISOString(),
      })),
      revokedTokens,
    });
  }),
);

export const syncRoutes = router;
