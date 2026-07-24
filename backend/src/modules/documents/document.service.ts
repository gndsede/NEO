import {
  DocumentStatus,
  DocumentOwnerType,
  RequirementCollectionStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getStorage } from "../../lib/storage/index.js";
import {
  contractorScopeWhere,
  workerScopeWhere,
  type AuthScope,
} from "../../lib/scope.js";
import { BadRequest, Forbidden, NotFound } from "../../lib/errors.js";
import { recomputeWorkerAccessValidity } from "../workers/worker.access.js";
import {
  recomputeRequirementItem,
  recomputeWorkerRequirements,
} from "../requirements/requirement-status.js";
import {
  sendRejectionNotice,
  type RejectionNoticeInput,
} from "../notifications/notification.service.js";
import type {
  AttachDocumentInput,
  ListDocumentsQuery,
} from "./document.schema.js";

// Busca dados do documento rejeitado e dispara o email à empreiteira.
// Executado como fire-and-forget — nunca lança para o caller.
async function notifyRejection(doc: {
  id: string;
  companyId: string;
  ownerType: DocumentOwnerType;
  workerId: string | null;
  contractorId: string | null;
  type: string;
  title: string | null;
  rejectionReason: string | null;
}): Promise<void> {
  const documentName = doc.title ?? doc.type;
  const reason = doc.rejectionReason ?? "Motivo não informado";

  let payload: RejectionNoticeInput | null = null;

  if (doc.ownerType === DocumentOwnerType.WORKER && doc.workerId) {
    const worker = await prisma.worker.findUnique({
      where: { id: doc.workerId },
      select: {
        fullName: true,
        assignments: {
          select: { contractor: { select: { name: true, email: true } } },
          orderBy: { createdAt: "desc" as const },
          take: 1,
        },
      },
    });
    const contractor = worker?.assignments[0]?.contractor;
    if (!contractor?.email) return;
    payload = {
      companyId: doc.companyId,
      documentId: doc.id,
      workerName: worker!.fullName,
      documentName,
      rejectionReason: reason,
      contractorName: contractor.name,
      contractorEmail: contractor.email,
    };
  } else if (doc.ownerType === DocumentOwnerType.CONTRACTOR && doc.contractorId) {
    const contractor = await prisma.contractor.findUnique({
      where: { id: doc.contractorId },
      select: { name: true, email: true },
    });
    if (!contractor?.email) return;
    payload = {
      companyId: doc.companyId,
      documentId: doc.id,
      workerName: contractor.name,
      documentName,
      rejectionReason: reason,
      contractorName: contractor.name,
      contractorEmail: contractor.email,
    };
  }

  if (payload) await sendRejectionNotice(payload);
}

interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

interface ReviewContext {
  /** Usuário que está avaliando (auditoria). */
  reviewerId: string;
  companyId: string;
}

export class DocumentService {
  private async getOwnedDocument(companyId: string, id: string) {
    const doc = await prisma.document.findFirst({
      where: { id, companyId },
    });
    if (!doc) throw NotFound("Documento não encontrado");
    return doc;
  }

  /**
   * Drivers S3/Supabase gravam `fileUrl` como URL pública crua do bucket —
   * se o bucket for privado, o navegador recebe 403 ao tentar abrir o
   * documento. O driver local já tem suas URLs assinadas por middleware
   * (app.ts), então aqui só reescrevemos para s3/supabase.
   */
  private async withViewUrl<T extends { fileUrl: string; fileKey: string | null }>(
    doc: T,
  ): Promise<T> {
    if (!doc.fileKey) return doc;
    const storage = await getStorage();
    if (storage.name === "local" || !storage.getSignedUrl) return doc;
    return { ...doc, fileUrl: await storage.getSignedUrl(doc.fileKey) };
  }

  private async withViewUrls<T extends { fileUrl: string; fileKey: string | null }>(
    docs: T[],
  ): Promise<T[]> {
    const storage = await getStorage();
    if (storage.name === "local" || !storage.getSignedUrl) return docs;
    return Promise.all(docs.map((doc) => this.withViewUrl(doc)));
  }

  async list(scope: AuthScope, query: ListDocumentsQuery) {
    const where: Prisma.DocumentWhereInput = {
      companyId: scope.companyId,
      // Escopo por obra: documento pertence a um worker/contractor dentro
      // das obras do usuário (ou é documento avulso da empresa).
      OR: [
        { worker: workerScopeWhere(scope) },
        { contractor: contractorScopeWhere(scope) },
        { AND: [{ workerId: null }, { contractorId: null }] },
      ],
      ...(query.ownerType ? { ownerType: query.ownerType } : {}),
      ...(query.workerId ? { workerId: query.workerId } : {}),
      ...(query.contractorId ? { contractorId: query.contractorId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(scope.allowedDocumentTypes
        ? { AND: [{ type: { in: scope.allowedDocumentTypes } }] }
        : {}),
    };

    const include = {
      reviewedBy: { select: { id: true, name: true, email: true } },
      uploadedBy: { select: { id: true, name: true, email: true } },
      worker: { select: { id: true, fullName: true } },
      contractor: { select: { id: true, name: true } },
    };
    const orderBy: Prisma.DocumentOrderByWithRelationInput[] = [
      { status: "asc" },
      { createdAt: "desc" },
    ];

    if (query.status === DocumentStatus.PENDENTE) {
      // Reenvios antes da revisão criam mais de um Document PENDENTE para o
      // mesmo item de exigência. Deduplicamos aqui (mantendo o mais recente)
      // para que a lista bata com a contagem de itens realmente pendentes.
      const all = await prisma.document.findMany({ where, include, orderBy });
      const seen = new Set<string>();
      const deduped = all.filter((doc) => {
        const key =
          doc.workerRequirementItemId ?? doc.contractorRequirementItemId ?? doc.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const total = deduped.length;
      const items = deduped.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      );
      return {
        items: await this.withViewUrls(items),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      };
    }

    const [total, items] = await Promise.all([
      prisma.document.count({ where }),
      prisma.document.findMany({
        where,
        include,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: await this.withViewUrls(items),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async getById(scope: AuthScope, id: string) {
    const doc = await prisma.document.findFirst({
      where: {
        id,
        companyId: scope.companyId,
        OR: [
          { worker: workerScopeWhere(scope) },
          { contractor: contractorScopeWhere(scope) },
          { AND: [{ workerId: null }, { contractorId: null }] },
        ],
        ...(scope.allowedDocumentTypes
          ? { type: { in: scope.allowedDocumentTypes } }
          : {}),
      },
      include: {
        reviewedBy: { select: { id: true, name: true, email: true } },
        uploadedBy: { select: { id: true, name: true, email: true } },
        worker: { select: { id: true, fullName: true } },
        contractor: { select: { id: true, name: true } },
      },
    });
    if (!doc) throw NotFound("Documento não encontrado");
    return this.withViewUrl(doc);
  }

  /**
   * Workflow de aprovação. Registra QUEM aprovou e QUANDO (auditoria).
   * Idempotência defensiva: não permite re-aprovar/re-rejeitar cegamente.
   */
  async approve(
    documentId: string,
    ctx: ReviewContext,
    opts?: { expiresAt?: Date },
  ) {
    const doc = await this.getOwnedDocument(ctx.companyId, documentId);
    if (doc.status === DocumentStatus.APROVADO) {
      throw BadRequest("Documento já está aprovado");
    }
    if (doc.uploadedById && doc.uploadedById === ctx.reviewerId) {
      throw Forbidden(
        "Quem anexou o documento não pode aprová-lo. A avaliação deve ser feita por outro usuário.",
      );
    }

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: DocumentStatus.APROVADO,
        reviewedById: ctx.reviewerId,
        reviewedAt: new Date(),
        rejectionReason: null,
        ...(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      },
      include: {
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (updated.workerRequirementItemId) {
      await prisma.workerRequirementItem.update({
        where: { id: updated.workerRequirementItemId },
        data: {
          status: RequirementCollectionStatus.APPROVED,
          naReason: null,
          latestDocumentId: updated.id,
        },
      });
      await recomputeRequirementItem(updated.workerRequirementItemId);
    }
    if (updated.contractorRequirementItemId) {
      await prisma.contractorRequirementItem.update({
        where: { id: updated.contractorRequirementItemId },
        data: {
          status: RequirementCollectionStatus.APPROVED,
          naReason: null,
          latestDocumentId: updated.id,
        },
      });
    }

    // Recalcula validade de acesso + situações efetivas das exigências do worker.
    if (updated.ownerType === DocumentOwnerType.WORKER && updated.workerId) {
      await recomputeWorkerAccessValidity(updated.workerId);
      await recomputeWorkerRequirements(updated.workerId);
    }

    return updated;
  }

  async reject(documentId: string, ctx: ReviewContext, reason: string) {
    const doc = await this.getOwnedDocument(ctx.companyId, documentId);
    if (doc.status === DocumentStatus.REJEITADO) {
      throw BadRequest("Documento já está rejeitado");
    }
    if (doc.uploadedById && doc.uploadedById === ctx.reviewerId) {
      throw Forbidden(
        "Quem anexou o documento não pode reprová-lo. A avaliação deve ser feita por outro usuário.",
      );
    }

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: DocumentStatus.REJEITADO,
        reviewedById: ctx.reviewerId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
      include: {
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (updated.workerRequirementItemId) {
      await prisma.workerRequirementItem.update({
        where: { id: updated.workerRequirementItemId },
        data: {
          status: RequirementCollectionStatus.REJECTED,
          latestDocumentId: updated.id,
        },
      });
      await recomputeRequirementItem(updated.workerRequirementItemId);
    }
    if (updated.contractorRequirementItemId) {
      await prisma.contractorRequirementItem.update({
        where: { id: updated.contractorRequirementItemId },
        data: {
          status: RequirementCollectionStatus.REJECTED,
          latestDocumentId: updated.id,
        },
      });
    }

    if (updated.ownerType === DocumentOwnerType.WORKER && updated.workerId) {
      await recomputeWorkerAccessValidity(updated.workerId);
      await recomputeWorkerRequirements(updated.workerId);
    }

    // Notifica a empreiteira sobre a reprovação (fire-and-forget)
    void notifyRejection(updated).catch(() => undefined);

    return updated;
  }

  /** Anexa um documento avulso (a Worker ou Contractor) via upload. */
  async attach(
    companyId: string,
    data: AttachDocumentInput,
    file?: UploadedFile,
    uploadedById?: string,
  ) {
    if (!file) throw BadRequest("Arquivo do documento é obrigatório");

    // Garante que o owner pertence ao tenant.
    if (data.ownerType === DocumentOwnerType.WORKER) {
      const w = await prisma.worker.findFirst({
        where: { id: data.workerId!, companyId },
        select: { id: true },
      });
      if (!w) throw NotFound("Colaborador não encontrado");
      if (data.workerRequirementItemId) {
        const item = await prisma.workerRequirementItem.findFirst({
          where: {
            id: data.workerRequirementItemId,
            companyId,
            workerId: data.workerId!,
          },
          select: { id: true, status: true },
        });
        if (!item) {
          throw NotFound("Exigência do colaborador não encontrada");
        }
        if (item.status === RequirementCollectionStatus.PENDING_APPROVAL) {
          throw BadRequest(
            "Já existe um documento aguardando avaliação para esta exigência. Aguarde a revisão antes de reenviar.",
          );
        }
      }
    } else {
      const c = await prisma.contractor.findFirst({
        where: { id: data.contractorId!, companyId },
        select: { id: true },
      });
      if (!c) throw NotFound("Empreiteira não encontrada");
      if (data.contractorRequirementItemId) {
        const item = await prisma.contractorRequirementItem.findFirst({
          where: {
            id: data.contractorRequirementItemId,
            companyId,
            contractorId: data.contractorId!,
          },
          select: { id: true, status: true },
        });
        if (!item) {
          throw NotFound("Exigência do fornecedor não encontrada");
        }
        if (item.status === RequirementCollectionStatus.PENDING_APPROVAL) {
          throw BadRequest(
            "Já existe um documento aguardando avaliação para esta exigência. Aguarde a revisão antes de reenviar.",
          );
        }
      }
    }

    const storage = await getStorage();
    const stored = await storage.upload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      folder: `companies/${companyId}/documents`,
    });

    const created = await prisma.document.create({
      data: {
        companyId,
        ownerType: data.ownerType,
        workerId: data.ownerType === "WORKER" ? data.workerId : null,
        contractorId:
          data.ownerType === "CONTRACTOR" ? data.contractorId : null,
        workerRequirementItemId:
          data.ownerType === "WORKER" ? data.workerRequirementItemId : null,
        contractorRequirementItemId:
          data.ownerType === "CONTRACTOR"
            ? data.contractorRequirementItemId
            : null,
        type: data.type,
        title: data.title,
        fileUrl: stored.url,
        fileKey: stored.key,
        mimeType: file.mimetype,
        fileSize: file.size,
        issuedAt: data.issuedAt,
        expiresAt: data.expiresAt,
        uploadedById,
      },
    });

    if (created.workerRequirementItemId) {
      await prisma.workerRequirementItem.update({
        where: { id: created.workerRequirementItemId },
        data: {
          status: RequirementCollectionStatus.PENDING_APPROVAL,
          naReason: null,
          latestDocumentId: created.id,
        },
      });
      await recomputeRequirementItem(created.workerRequirementItemId);
    }
    if (created.contractorRequirementItemId) {
      await prisma.contractorRequirementItem.update({
        where: { id: created.contractorRequirementItemId },
        data: {
          status: RequirementCollectionStatus.PENDING_APPROVAL,
          naReason: null,
          latestDocumentId: created.id,
        },
      });
    }

    return created;
  }
}

export const documentService = new DocumentService();
