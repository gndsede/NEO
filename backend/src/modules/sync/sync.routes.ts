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
 * Após a migração WorkerAssignment, os dados de turno/status/empreiteira vivem
 * no vínculo (assignment), não no Worker. Consultamos WorkerAssignment diretamente.
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

    const baseWhere = { companyId: company, obraId };

    // Além do updatedAt do próprio vínculo, precisamos capturar mudanças que
    // afetam a liberação de acesso mas não tocam o WorkerAssignment: uma
    // exigência pode virar pendente (ex.: admin adiciona documento obrigatório
    // à função) via WorkerRequirementItem, e um documento pode ser rejeitado,
    // sem que nenhuma dessas ações atualize o vínculo. Sem isso, o cache do
    // app da catraca nunca aprende sobre a pendência e libera indevidamente.
    const upsertsWhere = since
      ? {
          ...baseWhere,
          OR: [
            { updatedAt: { gte: since } },
            { requirementItems: { some: { updatedAt: { gte: since } } } },
            { worker: { documents: { some: { updatedAt: { gte: since } } } } },
          ],
        }
      : { ...baseWhere, status: { not: WorkerStatus.INACTIVE } };

    const assignments = await prisma.workerAssignment.findMany({
      where: upsertsWhere,
      select: {
        id: true,
        role: true,
        registration: true,
        status: true,
        accessValidUntil: true,
        updatedAt: true,
        contractor: { select: { id: true, name: true } },
        function: { select: { id: true, name: true } },
        worker: {
          select: {
            id: true,
            qrHash: true,
            fullName: true,
            photoUrl: true,
            updatedAt: true,
            documents: {
              where: { status: DocumentStatus.REJEITADO },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    let revokedTokens: string[] = [];
    if (since) {
      const revoked = await prisma.workerAssignment.findMany({
        where: {
          ...baseWhere,
          updatedAt: { gte: since },
          status: WorkerStatus.INACTIVE,
        },
        select: { worker: { select: { qrHash: true } } },
      });
      revokedTokens = revoked.map((a) => a.worker.qrHash);
    }

    // Consolida quais assignments têm exigências documentais pendentes
    const assignmentIds = assignments.map((a) => a.id);
    const pendingWorkerIds = new Set<string>();
    if (assignmentIds.length > 0) {
      const pending = await prisma.workerRequirementItem.findMany({
        where: {
          companyId: company,
          assignmentId: { in: assignmentIds },
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
      for (const p of pending) pendingWorkerIds.add(p.workerId);
    }

    const now = new Date();

    res.json({
      obraId,
      serverTime: now.toISOString(),
      since: since?.toISOString() ?? null,
      isInitialSync: !since,
      total: assignments.length,
      workers: assignments.map((a) => ({
        id: a.worker.id,
        token: a.worker.qrHash,
        fullName: a.worker.fullName,
        role: a.role,
        registration: a.registration,
        photoUrl: a.worker.photoUrl,
        status: a.status,
        accessValidUntil: a.accessValidUntil?.toISOString() ?? null,
        hasRejectedDocument: a.worker.documents.length > 0,
        hasPendingRequirements: pendingWorkerIds.has(a.worker.id),
        contractor: a.contractor ? { id: a.contractor.id, name: a.contractor.name } : null,
        function: a.function ? { id: a.function.id, name: a.function.name } : null,
        updatedAt: a.updatedAt.toISOString(),
      })),
      revokedTokens,
    });
  }),
);

export const syncRoutes = router;
